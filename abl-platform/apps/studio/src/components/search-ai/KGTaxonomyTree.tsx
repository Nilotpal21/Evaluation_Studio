/**
 * KGTaxonomyTree Component
 *
 * Collapsible tree view for Knowledge Graph taxonomy.
 * Transforms flat nodes+edges into a hierarchy and renders with
 * type-specific icons, badges, and expand/collapse animation.
 *
 * Drop-in replacement for SigmaGraphViewer — same props interface.
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import { ChevronRight, ChevronDown, Network, FolderTree, Package, Tag, Zap } from 'lucide-react';
import type { GraphNode, GraphEdge } from '../../api/search-ai';
import { Badge } from '../ui/Badge';
import type { BadgeVariant } from '../ui/Badge';

interface KGTaxonomyTreeProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick?: (node: GraphNode) => void;
  selectedNodeId?: string | null;
  className?: string;
}

interface TreeData {
  childrenMap: Map<string, GraphNode[]>;
  roots: GraphNode[];
}

/** Build parent→children map from flat nodes + edges. */
function buildTree(nodes: GraphNode[], edges: GraphEdge[]): TreeData {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const childrenMap = new Map<string, GraphNode[]>();
  const childIds = new Set<string>();

  for (const edge of edges) {
    const child = nodeMap.get(edge.to);
    if (!child || !nodeMap.has(edge.from)) continue;

    const siblings = childrenMap.get(edge.from) || [];
    siblings.push(child);
    childrenMap.set(edge.from, siblings);
    childIds.add(edge.to);
  }

  // Roots = nodes that are never the target of an edge
  const roots = nodes.filter((n) => !childIds.has(n.id));

  return { childrenMap, roots };
}

function getNodeIcon(type: GraphNode['type']) {
  switch (type) {
    case 'domain':
      return Network;
    case 'category':
      return FolderTree;
    case 'product':
      return Package;
    case 'attribute':
      return Tag;
    case 'entity_instance':
      return Zap;
    default:
      return Tag;
  }
}

function getNodeIconColor(type: GraphNode['type']): string {
  switch (type) {
    case 'domain':
      return 'text-accent';
    case 'category':
      return 'text-accent';
    case 'product':
      return 'text-purple';
    case 'attribute':
      return 'text-info';
    case 'entity_instance':
      return 'text-success';
    default:
      return 'text-muted';
  }
}

function getNodeBadge(
  node: GraphNode,
  childCount: number,
  t: ReturnType<typeof useTranslations>,
): { label: string; variant: BadgeVariant } | null {
  switch (node.type) {
    case 'domain':
      if (node.properties?.version)
        return { label: `v${node.properties.version}`, variant: 'accent' };
      return null;
    case 'category':
      if (childCount > 0)
        return { label: t('badge_products', { count: childCount }), variant: 'accent' };
      return null;
    case 'product': {
      const parts: string[] = [];
      if (node.properties?.documentCount !== undefined)
        parts.push(t('badge_docs', { count: node.properties.documentCount }));
      if (
        node.properties?.totalEntityInstances !== undefined &&
        Number(node.properties.totalEntityInstances) > 0
      )
        parts.push(t('badge_entities', { count: node.properties.totalEntityInstances }));
      if (parts.length > 0) return { label: parts.join(' · '), variant: 'accent' };
      return null;
    }
    case 'attribute':
      if (node.properties?.dataType) return { label: node.properties.dataType, variant: 'info' };
      return null;
    case 'entity_instance':
      if (node.properties?.documentCount !== undefined)
        return {
          label: t('badge_docs', { count: node.properties.documentCount }),
          variant: 'success',
        };
      return null;
    default:
      return null;
  }
}

function TreeNode({
  node,
  depth,
  childrenMap,
  expandedNodes,
  toggleExpanded,
  onNodeClick,
  selectedNodeId,
}: {
  node: GraphNode;
  depth: number;
  childrenMap: Map<string, GraphNode[]>;
  expandedNodes: Set<string>;
  toggleExpanded: (id: string) => void;
  onNodeClick?: (node: GraphNode) => void;
  selectedNodeId?: string | null;
}) {
  const children = childrenMap.get(node.id) || [];
  const hasChildren = children.length > 0;
  const isExpanded = expandedNodes.has(node.id);
  const isSelected = selectedNodeId === node.id;

  const t = useTranslations('search_ai.kg_tree');
  const Icon = getNodeIcon(node.type);
  const iconColor = getNodeIconColor(node.type);
  const badge = getNodeBadge(node, children.length, t);

  return (
    <div>
      <div
        className={clsx(
          'flex items-center gap-1.5 py-1.5 px-2 rounded-md cursor-pointer text-sm transition-default',
          'hover:bg-background-elevated',
          isSelected
            ? 'bg-accent-subtle border border-accent/30 text-foreground font-medium'
            : 'text-foreground',
        )}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
        onClick={() => onNodeClick?.(node)}
        role="treeitem"
        aria-expanded={hasChildren ? isExpanded : undefined}
      >
        {/* Chevron toggle */}
        {hasChildren ? (
          <button
            className="flex-shrink-0 p-0.5 rounded hover:bg-background-muted transition-default"
            onClick={(e) => {
              e.stopPropagation();
              toggleExpanded(node.id);
            }}
            aria-label={isExpanded ? t('collapse') : t('expand')}
          >
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-subtle" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-subtle" />
            )}
          </button>
        ) : (
          <span className="w-[18px] flex-shrink-0" />
        )}

        {/* Type icon */}
        <Icon className={clsx('w-4 h-4 flex-shrink-0', iconColor)} />

        {/* Label */}
        <span className="truncate">{node.label}</span>

        {/* Badge */}
        {badge && (
          <Badge variant={badge.variant} className="ml-auto flex-shrink-0">
            {badge.label}
          </Badge>
        )}
      </div>

      {/* Children with CSS Grid collapse animation */}
      {hasChildren && (
        <div className={clsx('collapse-content', isExpanded && 'open')}>
          <div role="group">
            {children.map((child) => (
              <TreeNode
                key={child.id}
                node={child}
                depth={depth + 1}
                childrenMap={childrenMap}
                expandedNodes={expandedNodes}
                toggleExpanded={toggleExpanded}
                onNodeClick={onNodeClick}
                selectedNodeId={selectedNodeId}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function KGTaxonomyTree({
  nodes,
  edges,
  onNodeClick,
  selectedNodeId,
  className,
}: KGTaxonomyTreeProps) {
  const tree = useMemo(() => buildTree(nodes, edges), [nodes, edges]);

  // Domain and category nodes expanded by default; products collapsed
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    return new Set(
      nodes.filter((n) => n.type === 'domain' || n.type === 'category').map((n) => n.id),
    );
  });

  const toggleExpanded = (id: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      className={clsx('bg-background border border-default rounded-lg overflow-y-auto', className)}
    >
      <div className="py-2" role="tree">
        {tree.roots.map((root) => (
          <TreeNode
            key={root.id}
            node={root}
            depth={0}
            childrenMap={tree.childrenMap}
            expandedNodes={expandedNodes}
            toggleExpanded={toggleExpanded}
            onNodeClick={onNodeClick}
            selectedNodeId={selectedNodeId}
          />
        ))}
      </div>
    </div>
  );
}
