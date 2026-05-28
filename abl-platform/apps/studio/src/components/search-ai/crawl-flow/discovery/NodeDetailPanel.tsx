'use client';

/**
 * NodeDetailPanel — Slide-out panel showing full developer info for a tree node.
 *
 * Uses SlidePanel (nonBlocking) so the tree remains interactive while the panel
 * is open. Shows: URL, status, render method, discovery source, foundOn list,
 * link frequency, page role, error details, and page list.
 */

import { SlidePanel } from '@/components/ui/SlidePanel';
import { Badge } from '@/components/ui/Badge';
import {
  Globe,
  Eye,
  AlertCircle,
  ExternalLink,
  FileText,
  Link2,
  Layers,
  Clock,
} from 'lucide-react';
import type { UnifiedTreeNode } from './unified-tree-types';

export interface NodeDetailPanelProps {
  node: UnifiedTreeNode | null;
  open: boolean;
  onClose: () => void;
}

const STATUS_LABELS: Record<string, { label: string; variant: string }> = {
  unexplored: { label: 'Unexplored', variant: 'default' },
  'auto-matched': { label: 'Suggested', variant: 'info' },
  exploring: { label: 'Exploring…', variant: 'warning' },
  explored: { label: 'Explored', variant: 'success' },
  error: { label: 'Error', variant: 'error' },
};

const SOURCE_LABELS: Record<string, string> = {
  'nav-header': 'Header navigation',
  'nav-footer': 'Footer navigation',
  'nav-mega-menu': 'Mega menu',
  sitemap: 'Sitemap',
  'http-explored': 'HTTP exploration',
  'bfs-discovered': 'BFS discovery',
  virtual: 'Virtual group',
};

const RENDER_METHOD_LABELS: Record<string, string> = {
  http: 'Static (HTTP)',
  browser: 'Dynamic (Browser)',
  unknown: 'Unknown',
};

const PAGE_ROLE_LABELS: Record<string, string> = {
  hub: 'Hub page (many outgoing links)',
  leaf: 'Leaf page (few outgoing links)',
  mixed: 'Mixed (moderate links)',
};

function DetailRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-default last:border-0">
      <Icon className="w-4 h-4 text-foreground-meta shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-foreground-meta mb-0.5">{label}</div>
        <div className="text-sm text-foreground">{children}</div>
      </div>
    </div>
  );
}

export function NodeDetailPanel({ node, open, onClose }: NodeDetailPanelProps) {
  if (!node) return null;

  const statusInfo = STATUS_LABELS[node.status] ?? {
    label: node.status,
    variant: 'default',
  };

  return (
    <SlidePanel
      open={open}
      onClose={onClose}
      title={node.label}
      description="Node details"
      width="sm"
      nonBlocking
    >
      <div className="space-y-1">
        {/* URL */}
        {node.url && (
          <DetailRow icon={Globe} label="URL">
            <a
              href={node.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline break-all flex items-center gap-1"
            >
              {node.url}
              <ExternalLink className="w-3 h-3 shrink-0" />
            </a>
          </DetailRow>
        )}

        {/* Status */}
        <DetailRow icon={Eye} label="Status">
          <Badge
            variant={statusInfo.variant as 'default' | 'info' | 'warning' | 'success' | 'error'}
            size="sm"
          >
            {statusInfo.label}
          </Badge>
          {node.errorMessage && <p className="text-xs text-error mt-1">{node.errorMessage}</p>}
        </DetailRow>

        {/* Render method */}
        {node.renderMethod && (
          <DetailRow icon={Layers} label="Rendering">
            {RENDER_METHOD_LABELS[node.renderMethod] ?? node.renderMethod}
          </DetailRow>
        )}

        {/* Discovery source */}
        <DetailRow icon={FileText} label="Discovered via">
          {SOURCE_LABELS[node.source] ?? node.source}
          {node.discoverySource && node.discoverySource !== node.source && (
            <span className="text-foreground-meta ml-1">({node.discoverySource})</span>
          )}
        </DetailRow>

        {/* Found on */}
        {node.foundOn && node.foundOn.length > 0 && (
          <DetailRow icon={Link2} label="Linked from">
            <div className="space-y-1">
              {node.foundOn.slice(0, 10).map((url) => (
                <div key={url} className="text-xs font-mono text-foreground-meta truncate">
                  {url}
                </div>
              ))}
              {node.foundOn.length > 10 && (
                <div className="text-xs text-foreground-meta">+{node.foundOn.length - 10} more</div>
              )}
            </div>
          </DetailRow>
        )}

        {/* Link frequency */}
        {node.linkFrequency !== undefined && node.linkFrequency > 0 && (
          <DetailRow icon={Link2} label="Link frequency">
            Linked from {node.linkFrequency} {node.linkFrequency === 1 ? 'page' : 'pages'}
            {node.isGlobalLink && (
              <Badge variant="warning" size="sm" className="ml-2">
                Global
              </Badge>
            )}
          </DetailRow>
        )}

        {/* Page role */}
        {node.pageRole && (
          <DetailRow icon={Layers} label="Page type">
            {PAGE_ROLE_LABELS[node.pageRole] ?? node.pageRole}
          </DetailRow>
        )}

        {/* Explored time */}
        {node.exploredAt && (
          <DetailRow icon={Clock} label="First seen">
            {new Date(node.exploredAt).toLocaleTimeString()}
          </DetailRow>
        )}

        {/* Pages */}
        {node.pages && node.pages.length > 0 && (
          <div className="pt-3 mt-2 border-t border-default">
            <h4 className="text-xs font-semibold text-foreground mb-2">
              Pages ({node.pages.length})
            </h4>
            <div className="space-y-1.5 max-h-60 overflow-y-auto">
              {node.pages.map((page) => (
                <div key={page.url} className="flex items-center gap-2 text-xs">
                  <FileText className="w-3 h-3 text-foreground-meta shrink-0" />
                  <a
                    href={page.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline truncate"
                    title={page.url}
                  >
                    {page.title || page.url}
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty pages prompt */}
        {(!node.pages || node.pages.length === 0) && node.status !== 'explored' && (
          <div className="pt-3 mt-2 border-t border-default">
            <p className="text-xs text-foreground-meta">Explore this section to discover pages</p>
          </div>
        )}
      </div>
    </SlidePanel>
  );
}
