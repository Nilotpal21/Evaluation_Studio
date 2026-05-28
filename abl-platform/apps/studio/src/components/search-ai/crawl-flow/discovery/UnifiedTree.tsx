'use client';

/**
 * UnifiedTree — Main container composing header, quick filters, guidance banner,
 * scrollable tree body, detail panel, and footer for the unified discovery tree.
 *
 * Uses @tanstack/react-virtual for virtualized rendering to handle
 * trees with 50,000+ nodes efficiently. The tree is flattened
 * (respecting expand/collapse state) into a list, then virtualized.
 *
 * Manages expand/collapse state, search filtering, quick filter state,
 * guidance banner visibility, node detail panel, and delegates
 * node exploration to the parent via callbacks.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '@/components/ui/Button';
import type { UnifiedTreeNode } from './unified-tree-types';
import { computeTreeStats } from './unified-tree-types';
import { toggleNodeIncluded, flattenUnifiedTree } from './tree-merge';
import { UnifiedTreeHeader } from './UnifiedTreeHeader';
import { UnifiedTreeNodeRow } from './UnifiedTreeNodeRow';
import { QuickFilters, type QuickFilterValue } from './QuickFilters';
import { GuidanceBanner } from './GuidanceBanner';
import { NodeDetailPanel } from './NodeDetailPanel';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface UnifiedTreeProps {
  /** The tree data */
  tree: UnifiedTreeNode[];
  /** Called when tree changes (toggle, explore result, etc.) */
  onTreeChange: (tree: UnifiedTreeNode[]) => void;
  /** Called when user clicks "Explore" on a node */
  onExploreNode: (nodeId: string, nodeUrl: string) => void;
  /** Called when user clicks "Configure Crawl" */
  onConfigureCrawl: () => void;
  /** Whether any exploration is currently running */
  isExploring: boolean;
  /** Search/filter query (controlled) */
  searchQuery?: string;
  /** Optional: collapsed node IDs (controlled) */
  collapsedNodes?: Set<string>;
  onCollapsedNodesChange?: (collapsed: Set<string>) => void;
  /** Sample URLs for context bar in header */
  sampleUrls?: string[];
  /** 'live' = BFS discovery in progress (read-only), 'select' = post-discovery selection */
  mode?: 'live' | 'select';
  /** Active view mode */
  viewMode?: import('./UnifiedTreeHeader').TreeViewMode;
  /** Callback when user switches view */
  onViewModeChange?: (mode: import('./UnifiedTreeHeader').TreeViewMode) => void;
  /** Whether sitemap is available */
  hasSitemap?: boolean;
  /** Callback for "Add from Sitemap" */
  onAddFromSitemap?: () => void;
}

/* ------------------------------------------------------------------ */
/*  Tree filtering                                                     */
/* ------------------------------------------------------------------ */

/**
 * Filter tree by search query, preserving parent chain.
 * A node is included if its label matches OR any descendant matches.
 */
function filterTree(nodes: UnifiedTreeNode[], query: string): UnifiedTreeNode[] {
  if (!query) return nodes;
  const lowerQuery = query.toLowerCase();

  function matches(node: UnifiedTreeNode): boolean {
    if (node.label.toLowerCase().includes(lowerQuery)) return true;
    return node.children.some(matches);
  }

  function prune(nodeList: UnifiedTreeNode[]): UnifiedTreeNode[] {
    const result: UnifiedTreeNode[] = [];
    for (const node of nodeList) {
      if (matches(node)) {
        const filteredChildren = prune(node.children);
        result.push({ ...node, children: filteredChildren });
      }
    }
    return result;
  }

  return prune(nodes);
}

/**
 * Filter tree by QuickFilter value, preserving parent chain.
 */
function filterTreeByQuickFilter(
  nodes: UnifiedTreeNode[],
  filter: QuickFilterValue,
): UnifiedTreeNode[] {
  if (filter === 'all') return nodes;

  function nodeMatchesFilter(node: UnifiedTreeNode): boolean {
    switch (filter) {
      case 'selected':
        return node.included;
      case 'suggested':
        return node.status === 'auto-matched';
      case 'unexplored':
        return node.status === 'unexplored';
      case 'errors':
        return node.status === 'error';
      default:
        return true;
    }
  }

  function anyDescendantMatches(node: UnifiedTreeNode): boolean {
    if (nodeMatchesFilter(node)) return true;
    return node.children.some(anyDescendantMatches);
  }

  function prune(nodeList: UnifiedTreeNode[]): UnifiedTreeNode[] {
    const result: UnifiedTreeNode[] = [];
    for (const node of nodeList) {
      if (anyDescendantMatches(node)) {
        const filteredChildren = prune(node.children);
        result.push({ ...node, children: filteredChildren });
      }
    }
    return result;
  }

  return prune(nodes);
}

/**
 * Collect all node IDs that have children (for expand all).
 */
function collectParentIds(nodes: UnifiedTreeNode[]): Set<string> {
  const ids = new Set<string>();
  function walk(nodeList: UnifiedTreeNode[]): void {
    for (const node of nodeList) {
      if (node.children.length > 0) {
        ids.add(node.id);
        walk(node.children);
      }
    }
  }
  walk(nodes);
  return ids;
}

/**
 * Set included on all nodes.
 */
function setAllIncluded(nodes: UnifiedTreeNode[], included: boolean): UnifiedTreeNode[] {
  return nodes.map((node) => ({
    ...node,
    included,
    children: setAllIncluded(node.children, included),
  }));
}

/**
 * Set included=true on all auto-matched nodes.
 */
function selectSuggestedNodes(nodes: UnifiedTreeNode[]): UnifiedTreeNode[] {
  return nodes.map((node) => ({
    ...node,
    included: node.status === 'auto-matched' ? true : node.included,
    children: selectSuggestedNodes(node.children),
  }));
}

/**
 * Compute collapsed set: all parents collapsed EXCEPT those with active children.
 * Returns the set of node IDs that should START collapsed.
 * "Active" = explored, auto-matched, exploring, or having children themselves.
 */
function computeAutoCollapsed(tree: UnifiedTreeNode[]): Set<string> {
  const allParents = collectParentIds(tree);
  const toExpand = new Set<string>();
  function walk(nodes: UnifiedTreeNode[]) {
    for (const n of nodes) {
      const hasActiveChild = n.children.some(
        (c) =>
          c.status === 'explored' ||
          c.status === 'auto-matched' ||
          c.status === 'exploring' ||
          c.children.length > 0,
      );
      if (hasActiveChild || n.status === 'explored' || n.status === 'auto-matched') {
        toExpand.add(n.id);
      }
      walk(n.children);
    }
  }
  walk(tree);
  const collapsed = new Set<string>();
  for (const id of allParents) {
    if (!toExpand.has(id)) collapsed.add(id);
  }
  return collapsed;
}

/**
 * Find a node by ID in the tree.
 */
function findNodeById(nodes: UnifiedTreeNode[], id: string): UnifiedTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNodeById(node.children, id);
    if (found) return found;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Flattened row type                                                  */
/* ------------------------------------------------------------------ */

interface FlatRow {
  node: UnifiedTreeNode;
  depth: number;
}

/**
 * Flatten the tree into a list of visible rows, respecting collapsed state.
 * Only expanded children are included.
 */
function flattenVisibleTree(
  nodes: UnifiedTreeNode[],
  collapsedIds: Set<string>,
  depth: number = 0,
): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.children.length > 0 && !collapsedIds.has(node.id)) {
      rows.push(...flattenVisibleTree(node.children, collapsedIds, depth + 1));
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Estimated row height in pixels for the virtualizer */
const ROW_HEIGHT_PX = 36;
/** Maximum container height before scrolling kicks in */
const MAX_TREE_HEIGHT_PX = 520;

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function UnifiedTree({
  tree,
  onTreeChange,
  onExploreNode,
  onConfigureCrawl,
  isExploring,
  searchQuery: controlledSearchQuery,
  collapsedNodes: controlledCollapsedNodes,
  onCollapsedNodesChange,
  sampleUrls,
  mode = 'select',
  viewMode,
  onViewModeChange,
  hasSitemap,
  onAddFromSitemap,
}: UnifiedTreeProps) {
  // Internal state (used when not controlled)
  const [internalCollapsed, setInternalCollapsed] = useState<Set<string>>(() =>
    computeAutoCollapsed(tree),
  );
  const autoExpandedRef = useRef<Set<string>>(new Set());
  const [internalSearchQuery, setInternalSearchQuery] = useState('');
  const [quickFilter, setQuickFilter] = useState<QuickFilterValue>('all');
  const [guidanceDismissed, setGuidanceDismissed] = useState(false);
  const [detailNodeId, setDetailNodeId] = useState<string | null>(null);

  // Resolve controlled vs uncontrolled
  const collapsedIds = controlledCollapsedNodes ?? internalCollapsed;
  const searchQuery = controlledSearchQuery ?? internalSearchQuery;

  const updateCollapsed = useCallback(
    (next: Set<string>) => {
      if (onCollapsedNodesChange) {
        onCollapsedNodesChange(next);
      } else {
        setInternalCollapsed(next);
      }
    },
    [onCollapsedNodesChange],
  );

  // Auto-expand newly active parents when tree updates (e.g., after node exploration)
  useEffect(() => {
    // Skip in controlled mode — parent manages collapsed state
    if (controlledCollapsedNodes !== undefined) return;

    const autoCollapsed = computeAutoCollapsed(tree);
    const allParents = collectParentIds(tree);

    setInternalCollapsed((prev) => {
      const next = new Set(prev);
      for (const id of allParents) {
        const wantsExpanded = !autoCollapsed.has(id);
        const wasAutoExpanded = autoExpandedRef.current.has(id);
        if (wantsExpanded && !wasAutoExpanded) {
          next.delete(id);
          autoExpandedRef.current.add(id);
        }
      }
      return next;
    });
  }, [tree, controlledCollapsedNodes]);

  // Stats
  const stats = useMemo(() => computeTreeStats(tree), [tree]);

  // Visited count for live mode
  const visitedCount = useMemo(() => {
    if (mode !== 'live') return 0;
    return flattenUnifiedTree(tree).filter((n) => n.visited).length;
  }, [tree, mode]);

  // Apply quick filter first, then search filter
  const quickFilteredTree = useMemo(
    () => filterTreeByQuickFilter(tree, quickFilter),
    [tree, quickFilter],
  );
  const filteredTree = useMemo(
    () => filterTree(quickFilteredTree, searchQuery),
    [quickFilteredTree, searchQuery],
  );

  // Flatten tree into visible rows for virtualization
  const flatRows = useMemo(
    () => flattenVisibleTree(filteredTree, collapsedIds),
    [filteredTree, collapsedIds],
  );

  // Scroll container ref for virtualizer
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Virtualizer
  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 20,
  });

  // Compute container height: min(rows * ROW_HEIGHT, MAX_TREE_HEIGHT)
  const containerHeight = Math.min(flatRows.length * ROW_HEIGHT_PX, MAX_TREE_HEIGHT_PX);

  // Detail panel node
  const detailNode = useMemo(
    () => (detailNodeId ? findNodeById(tree, detailNodeId) : null),
    [tree, detailNodeId],
  );

  // Handlers
  const handleToggleCollapse = useCallback(
    (id: string) => {
      const next = new Set(collapsedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      updateCollapsed(next);
    },
    [collapsedIds, updateCollapsed],
  );

  const handleToggleIncluded = useCallback(
    (nodeId: string, included: boolean) => {
      onTreeChange(toggleNodeIncluded(tree, nodeId, included));
    },
    [tree, onTreeChange],
  );

  const handleExpandAll = useCallback(() => {
    updateCollapsed(new Set());
  }, [updateCollapsed]);

  const handleCollapseAll = useCallback(() => {
    updateCollapsed(collectParentIds(tree));
  }, [tree, updateCollapsed]);

  const handleSelectAll = useCallback(() => {
    onTreeChange(setAllIncluded(tree, true));
  }, [tree, onTreeChange]);

  const handleDeselectAll = useCallback(() => {
    onTreeChange(setAllIncluded(tree, false));
  }, [tree, onTreeChange]);

  const handleSelectSuggested = useCallback(() => {
    onTreeChange(selectSuggestedNodes(tree));
  }, [tree, onTreeChange]);

  const handleSearchChange = useCallback(
    (query: string) => {
      if (controlledSearchQuery === undefined) {
        setInternalSearchQuery(query);
      }
      // If controlled, parent handles search state
    },
    [controlledSearchQuery],
  );

  const handleCloseDetail = useCallback(() => {
    setDetailNodeId(null);
  }, []);

  // Show guidance banner in select mode when there are auto-matched nodes and not dismissed
  const showGuidance = mode === 'select' && stats.autoMatchedNodes > 0 && !guidanceDismissed;

  return (
    <div className="flex flex-col" data-testid="unified-tree">
      {/* Header */}
      <UnifiedTreeHeader
        stats={stats}
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        onExpandAll={handleExpandAll}
        onCollapseAll={handleCollapseAll}
        onSelectAll={handleSelectAll}
        onDeselectAll={handleDeselectAll}
        onSelectSuggested={handleSelectSuggested}
        sampleUrls={sampleUrls}
        mode={mode}
        visitedCount={visitedCount}
        viewMode={viewMode}
        onViewModeChange={onViewModeChange}
        hasSitemap={hasSitemap}
        onAddFromSitemap={onAddFromSitemap}
      />

      {/* Guidance banner — shown post-discovery before user starts selecting */}
      {showGuidance && (
        <GuidanceBanner
          suggestedCount={stats.autoMatchedNodes}
          onSelectSuggested={handleSelectSuggested}
          onDismiss={() => setGuidanceDismissed(true)}
        />
      )}

      {/* Quick filters — select mode only */}
      {mode === 'select' && (
        <QuickFilters stats={stats} value={quickFilter} onChange={setQuickFilter} />
      )}

      {/* Virtualized scrollable tree body */}
      {flatRows.length > 0 ? (
        <div
          ref={scrollContainerRef}
          className="overflow-y-auto py-1"
          style={{ height: containerHeight, maxHeight: MAX_TREE_HEIGHT_PX }}
          data-testid="unified-tree-scroll"
        >
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const { node, depth } = flatRows[virtualRow.index];
              return (
                <div
                  key={node.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                >
                  <UnifiedTreeNodeRow
                    node={node}
                    depth={depth}
                    isCollapsed={collapsedIds.has(node.id)}
                    onToggleCollapse={handleToggleCollapse}
                    onToggleIncluded={handleToggleIncluded}
                    onExploreNode={onExploreNode}
                    mode={mode}
                    onShowDetail={setDetailNodeId}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div
          className="px-4 py-8 text-center text-sm text-foreground-meta"
          data-testid="unified-tree-empty"
        >
          {searchQuery
            ? 'No nodes match your search'
            : quickFilter !== 'all'
              ? 'No nodes match this filter'
              : 'No discovery data yet'}
        </div>
      )}

      {/* Footer */}
      <div
        className="px-4 py-3 border-t border-default bg-background-muted/50"
        data-testid="unified-tree-footer"
      >
        <div className="flex items-center justify-between">
          {mode === 'live' ? (
            <div className="text-xs text-foreground-meta" data-testid="unified-tree-footer-stats">
              <span className="font-medium text-foreground">{stats.totalNodes}</span> URLs found
              {' \u00B7 '}
              <span className="font-medium text-foreground">{visitedCount}</span> pages visited
            </div>
          ) : (
            <>
              <div className="text-xs text-foreground-meta" data-testid="unified-tree-footer-stats">
                {stats.virtualFolders > 0 && (
                  <>
                    <span className="font-medium text-foreground">{stats.virtualFolders}</span>{' '}
                    folders +{' '}
                  </>
                )}
                <span className="font-medium text-foreground">{stats.includedNodes}</span>{' '}
                {stats.virtualFolders > 0 ? 'pages' : 'sections'} selected
                {' \u00B7 '}
                <span className="font-medium text-foreground">{stats.includedPages}</span> pages in
                scope
                {stats.sitemapPages > 0 && (
                  <>
                    {' \u00B7 Sources: '}
                    <span className="font-medium text-foreground">{stats.exploredPages}</span>{' '}
                    explored
                    {' \u00B7 '}
                    <span className="font-medium text-foreground">{stats.sitemapPages}</span> from
                    sitemap
                  </>
                )}
              </div>
              <Button
                variant="primary"
                size="sm"
                disabled={stats.includedNodes === 0 || isExploring}
                loading={isExploring}
                onClick={onConfigureCrawl}
                data-testid="configure-crawl-btn"
              >
                Continue with {stats.includedNodes} sections
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Node detail panel — nonBlocking slide-out */}
      <NodeDetailPanel node={detailNode} open={detailNodeId !== null} onClose={handleCloseDetail} />
    </div>
  );
}
