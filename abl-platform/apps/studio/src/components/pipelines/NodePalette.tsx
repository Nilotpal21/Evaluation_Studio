/**
 * Node Palette
 *
 * Left sidebar (240px) with searchable, categorized list of available
 * pipeline node types. Nodes are draggable onto the React Flow canvas.
 *
 * Fetches node types from GET /api/pipelines/nodes.
 * Groups by category: data, logic, integration, compute, action.
 */

'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Search, ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import { clsx } from 'clsx';
import type { NodeTypeDefinition, NodeCategory } from '@agent-platform/pipeline-engine';
import { getBadgeIntentStyles } from '@agent-platform/design-tokens';
import type { SemanticIntent } from '@agent-platform/design-tokens';
import { Input } from '../ui/Input';
import { apiFetch } from '@/lib/api-client';

// =============================================================================
// Types
// =============================================================================

export interface NodePaletteProps {
  isOpen: boolean;
  onToggle: () => void;
}

interface NodeTypeGroup {
  category: NodeCategory;
  label: string;
  nodes: NodeTypeDefinition[];
}

// =============================================================================
// Constants
// =============================================================================

const CATEGORY_ORDER: NodeCategory[] = ['data', 'logic', 'integration', 'compute', 'action'];

const CATEGORY_LABELS: Record<NodeCategory, string> = {
  data: 'Data',
  logic: 'Logic',
  integration: 'Integration',
  compute: 'Compute',
  action: 'Action',
};

const CATEGORY_INTENT: Record<NodeCategory, SemanticIntent> = {
  data: 'info',
  logic: 'info',
  integration: 'success',
  compute: 'orange',
  action: 'error',
};

function getCategoryBadgeClasses(category: NodeCategory): string {
  return getBadgeIntentStyles(CATEGORY_INTENT[category]).badge;
}

// =============================================================================
// Component
// =============================================================================

export function NodePalette({ isOpen, onToggle }: NodePaletteProps) {
  const t = useTranslations('pipelines');
  const [search, setSearch] = useState('');
  const [nodeTypes, setNodeTypes] = useState<NodeTypeDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedCategories, setExpandedCategories] = useState<Set<NodeCategory>>(
    new Set(CATEGORY_ORDER),
  );

  // Fetch node types
  useEffect(() => {
    let cancelled = false;

    async function fetchNodeTypes() {
      try {
        const res = await apiFetch('/api/pipelines/nodes');
        if (!res.ok) return;
        const json = (await res.json()) as { success: boolean; data: NodeTypeDefinition[] };
        if (!cancelled && json.success) {
          setNodeTypes(json.data);
        }
      } catch {
        // Silently handle fetch errors — palette shows empty
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchNodeTypes();
    return () => {
      cancelled = true;
    };
  }, []);

  // Filter and group nodes
  const groups = useMemo<NodeTypeGroup[]>(() => {
    const searchLower = search.toLowerCase().trim();

    const filtered = searchLower
      ? nodeTypes.filter(
          (n) =>
            n.label.toLowerCase().includes(searchLower) ||
            n.description.toLowerCase().includes(searchLower) ||
            n.type.toLowerCase().includes(searchLower),
        )
      : nodeTypes;

    return CATEGORY_ORDER.map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      nodes: filtered.filter((n) => n.category === category),
    })).filter((g) => g.nodes.length > 0);
  }, [nodeTypes, search]);

  const toggleCategory = useCallback((category: NodeCategory) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, nodeType: NodeTypeDefinition) => {
      event.dataTransfer.setData('application/pipeline-node', JSON.stringify(nodeType));
      event.dataTransfer.effectAllowed = 'move';
    },
    [],
  );

  if (!isOpen) return null;

  return (
    <div className="w-60 border-r border-default bg-background flex flex-col shrink-0 h-full">
      {/* Header */}
      <div className="px-3 py-3 border-b border-default">
        <h3 className="text-sm font-semibold text-foreground mb-2">{t('editor_node_palette')}</h3>
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('search_placeholder')}
          icon={<Search className="w-3.5 h-3.5" />}
          className="!py-1.5 !text-xs"
        />
      </div>

      {/* Node list */}
      <div className="flex-1 overflow-y-auto py-1">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!loading && groups.length === 0 && (
          <p className="text-xs text-muted px-3 py-4 text-center">{t('no_matching_pipelines')}</p>
        )}

        {groups.map((group) => {
          const isExpanded = expandedCategories.has(group.category);

          return (
            <div key={group.category}>
              {/* Category header */}
              <button
                type="button"
                className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-foreground-muted hover:text-foreground hover:bg-background-muted transition-colors"
                onClick={() => toggleCategory(group.category)}
              >
                {isExpanded ? (
                  <ChevronDown className="w-3 h-3 shrink-0" />
                ) : (
                  <ChevronRight className="w-3 h-3 shrink-0" />
                )}
                <span
                  className={clsx(
                    'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border',
                    getCategoryBadgeClasses(group.category),
                  )}
                >
                  {group.label}
                </span>
                <span className="text-xs text-muted ml-auto">{group.nodes.length}</span>
              </button>

              {/* Node items */}
              {isExpanded && (
                <div className="pb-1">
                  {group.nodes.map((nodeType) => (
                    <div
                      key={nodeType.type}
                      draggable
                      onDragStart={(e) => handleDragStart(e, nodeType)}
                      className="mx-2 mb-1 px-2 py-2 rounded-md border border-default bg-background-elevated hover:bg-background-muted cursor-grab active:cursor-grabbing transition-colors group"
                    >
                      <div className="flex items-center gap-1.5">
                        <GripVertical className="w-3 h-3 text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                        <span className="text-xs font-medium text-foreground truncate">
                          {nodeType.label}
                        </span>
                      </div>
                      <p className="text-xs text-muted mt-0.5 line-clamp-2 pl-5">
                        {nodeType.description}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
