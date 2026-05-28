'use client';

/**
 * UnifiedTreeNodeRow — Renders a single row in the unified discovery tree.
 *
 * Redesigned for clarity: max 6 visual elements per row.
 * All developer info (render method, discovery source, link frequency, etc.)
 * moved to the on-demand NodeDetailPanel.
 *
 * Layout: [chevron] [icon] [checkbox?] [label]       [status area] [hover: link]
 *
 * Status area shows exactly ONE element based on node state:
 *   - Unexplored (has URL)  → [Explore] button (always visible)
 *   - Exploring              → spinner + "Exploring…"
 *   - Explored               → "N pages" text
 *   - Auto-matched           → "Suggested" label
 *   - Error                  → "Could not reach" + Retry
 *   - No URL (virtual)       → empty
 */

import { useCallback } from 'react';
import { clsx } from 'clsx';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileText,
  Loader2,
  Check,
  ExternalLink,
  RefreshCw,
  MoreHorizontal,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import type { UnifiedTreeNode } from './unified-tree-types';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface UnifiedTreeNodeRowProps {
  node: UnifiedTreeNode;
  depth: number;
  isCollapsed: boolean;
  onToggleCollapse: (nodeId: string) => void;
  onToggleIncluded: (nodeId: string, included: boolean) => void;
  onExploreNode: (nodeId: string, nodeUrl: string) => void;
  /** 'live' = BFS discovery in progress (read-only), 'select' = post-discovery selection */
  mode?: 'live' | 'select';
  /** Called when user clicks "..." to show detail panel */
  onShowDetail?: (nodeId: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function UnifiedTreeNodeRow({
  node,
  depth,
  isCollapsed,
  onToggleCollapse,
  onToggleIncluded,
  onExploreNode,
  mode = 'select',
  onShowDetail,
}: UnifiedTreeNodeRowProps) {
  const hasChildren = node.children.length > 0;
  const isExploring = node.status === 'exploring';
  const isExplored = node.status === 'explored';
  const isAutoMatched = node.status === 'auto-matched';
  const isError = node.status === 'error';
  const isUnexplored = node.status === 'unexplored';
  const canExplore = node.url !== '' && !isExplored && !isExploring;
  const hasNoUrl = node.url === '';

  // Checkbox visible for explored/auto-matched/virtual nodes in select mode
  const showCheckbox =
    mode === 'select' && (isExplored || isAutoMatched || node.isVirtual === true);

  // Handlers
  const handleToggleCollapse = useCallback(() => {
    if (hasChildren) onToggleCollapse(node.id);
  }, [hasChildren, node.id, onToggleCollapse]);

  const handleToggleIncluded = useCallback(() => {
    onToggleIncluded(node.id, !node.included);
  }, [node.id, node.included, onToggleIncluded]);

  const handleExplore = useCallback(() => {
    if (canExplore) onExploreNode(node.id, node.url);
  }, [canExplore, node.id, node.url, onExploreNode]);

  // ─── Status area: exactly ONE element based on state ──────────────

  function renderStatusArea() {
    // Error → "Could not reach" + Retry
    if (isError) {
      return (
        <span className="flex items-center gap-1 shrink-0">
          <Tooltip content={node.errorMessage ?? 'Failed'}>
            <span className="text-xs text-error">Could not reach</span>
          </Tooltip>
          {node.url !== '' && (
            <Button
              variant="ghost"
              size="xs"
              onClick={handleExplore}
              icon={<RefreshCw className="w-3 h-3" />}
              data-testid="tree-node-retry"
            >
              Retry
            </Button>
          )}
        </span>
      );
    }

    // Exploring → spinner + "Exploring…"
    if (isExploring) {
      return (
        <span className="flex items-center gap-1.5 text-xs text-info shrink-0">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Exploring…
        </span>
      );
    }

    // Explored → page count
    if (isExplored && (node.pageCount ?? 0) > 0) {
      return (
        <Tooltip
          content={`${node.pageCount} pages found under this section. Select to include in crawl.`}
        >
          <span className="text-xs text-foreground-meta shrink-0" data-testid="tree-node-pages">
            {node.pageCount} {node.pageCount === 1 ? 'page' : 'pages'}
          </span>
        </Tooltip>
      );
    }

    // Auto-matched → "Suggested"
    if (isAutoMatched) {
      return (
        <Tooltip content={`Matches your sample URL: ${node.matchedPattern ?? 'pattern'}`}>
          <span className="text-xs text-accent shrink-0" data-testid="tree-node-suggested">
            Suggested
          </span>
        </Tooltip>
      );
    }

    // Unexplored with URL → always-visible Explore button
    if (isUnexplored && canExplore) {
      if (mode === 'select') {
        return (
          <Tooltip content="Visit this URL and discover pages underneath it">
            <span>
              <Button
                variant="ghost"
                size="xs"
                onClick={handleExplore}
                data-testid="tree-node-explore"
              >
                Explore
              </Button>
            </span>
          </Tooltip>
        );
      }
      // Live mode — also show explore affordance (discover more)
      if (mode === 'live') {
        return (
          <Tooltip content="Discover more from this node">
            <span>
              <Button
                variant="ghost"
                size="xs"
                onClick={handleExplore}
                data-testid="tree-node-discover-more"
              >
                Explore
              </Button>
            </span>
          </Tooltip>
        );
      }
    }

    // No URL (virtual folder) or explored with 0 pages → empty
    return null;
  }

  return (
    <div
      className={clsx(
        'group flex items-center gap-1.5 py-1.5 px-2 rounded-md transition-colors',
        'hover:bg-background-muted/60',
        node.included && 'bg-accent-subtle/30',
        isError && 'bg-error/5',
        isExploring && 'bg-info/5',
      )}
      style={{ paddingLeft: `${depth * 20 + 8}px` }}
      data-testid={`tree-node-${node.id}`}
      data-node-status={node.status}
      data-node-included={node.included}
    >
      {/* Expand/collapse chevron */}
      <button
        onClick={handleToggleCollapse}
        className={clsx(
          'flex items-center justify-center w-5 h-5 rounded transition-colors shrink-0',
          hasChildren ? 'hover:bg-background-muted cursor-pointer' : 'cursor-default',
        )}
        aria-label={hasChildren ? (isCollapsed ? 'Expand' : 'Collapse') : undefined}
        data-testid="tree-node-toggle"
      >
        {hasChildren ? (
          isCollapsed ? (
            <ChevronRight className="w-3.5 h-3.5 text-foreground-meta" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-foreground-meta" />
          )
        ) : (
          <span className="w-3.5" />
        )}
      </button>

      {/* Icon: folder or file. Spinner replaces icon during exploration. */}
      <span className="shrink-0">
        {isExploring ? (
          <Loader2 className="w-4 h-4 text-info animate-spin" />
        ) : hasChildren ? (
          isCollapsed ? (
            <Folder
              className={clsx('w-4 h-4', node.isVirtual ? 'text-foreground-meta' : 'text-warning')}
            />
          ) : (
            <FolderOpen
              className={clsx('w-4 h-4', node.isVirtual ? 'text-foreground-meta' : 'text-warning')}
            />
          )
        ) : (
          <FileText className="w-4 h-4 text-foreground-meta" />
        )}
      </span>

      {/* Checkbox — select mode only, for explored/auto-matched/virtual nodes */}
      {showCheckbox ? (
        <button
          onClick={handleToggleIncluded}
          className={clsx(
            'flex items-center justify-center w-4 h-4 rounded border transition-colors shrink-0',
            node.included
              ? 'bg-accent border-accent'
              : 'bg-background-subtle border-default hover:border-accent',
          )}
          aria-label={node.included ? 'Exclude from scope' : 'Include in scope'}
          data-testid="tree-node-checkbox"
        >
          {node.included && <Check className="w-3 h-3 text-accent-foreground" strokeWidth={3} />}
        </button>
      ) : (
        mode === 'select' && <span className="w-4 shrink-0" />
      )}

      {/* Label — truncated, full URL on hover */}
      <Tooltip content={node.url || node.label}>
        <span
          className={clsx(
            'text-sm truncate flex-1 min-w-0',
            isError ? 'text-error' : 'text-foreground',
            node.included && 'font-medium',
          )}
          data-testid="tree-node-label"
        >
          {node.label}
        </span>
      </Tooltip>

      {/* Status area — exactly one element */}
      {renderStatusArea()}

      {/* Hover: detail + external link */}
      <div className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 flex items-center gap-0.5">
        {onShowDetail && (
          <Tooltip content="View details">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onShowDetail(node.id);
              }}
              className="p-1 rounded hover:bg-background-muted transition-colors"
              data-testid="tree-node-detail"
            >
              <MoreHorizontal className="w-3.5 h-3.5 text-foreground-meta" />
            </button>
          </Tooltip>
        )}
        {node.url && (
          <Tooltip content={node.url}>
            <a
              href={node.url}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1 rounded hover:bg-background-muted transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="w-3.5 h-3.5 text-foreground-meta" />
            </a>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
