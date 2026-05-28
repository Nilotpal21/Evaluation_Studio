'use client';

/**
 * ScopeFiltersSplitPane
 *
 * 60/40 split-pane layout for iterative filter configuration.
 * Left: filter controls. Right: live preview.
 * Auto-expands the panel on mount, collapses on unmount.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useConnectorStore } from '../../../store/connector-store';
import { useConnectorDiscovery } from '../../../hooks/useConnectorDiscovery';
import {
  useFilterPreview,
  createDefaultFilterConfig,
  type FilterConfig,
} from '../../../hooks/useFilterPreview';
import { ScopeControlsPanel } from './ScopeControlsPanel';
import { ScopePreviewPanel } from './ScopePreviewPanel';

interface ScopeFiltersSplitPaneProps {
  indexId: string;
  connectorId: string;
  isDraftMode: boolean;
}

const MAX_UNDO_HISTORY = 20;

export function ScopeFiltersSplitPane({
  indexId,
  connectorId,
  isDraftMode,
}: ScopeFiltersSplitPaneProps) {
  const setExpandedPanel = useConnectorStore((s) => s.setExpandedPanel);

  // Auto-expand on mount for scope-filters (needs more screen real estate).
  // Do NOT collapse on unmount — respect the user's current width preference.
  useEffect(() => {
    setExpandedPanel(true);
  }, [setExpandedPanel]);

  // Filter config state with undo history
  const [filterConfig, setFilterConfig] = useState<FilterConfig>(createDefaultFilterConfig());
  const undoHistoryRef = useRef<FilterConfig[]>([]);
  const initialConfigRef = useRef<FilterConfig>(createDefaultFilterConfig());

  const handleFilterChange = useCallback((newConfig: FilterConfig) => {
    setFilterConfig((prev) => {
      // Push current to undo history
      const history = [...undoHistoryRef.current, prev];
      if (history.length > MAX_UNDO_HISTORY) {
        history.shift();
      }
      undoHistoryRef.current = history;
      return newConfig;
    });
  }, []);

  const handleUndo = useCallback(() => {
    const history = undoHistoryRef.current;
    if (history.length === 0) return;
    const previous = history[history.length - 1];
    undoHistoryRef.current = history.slice(0, -1);
    setFilterConfig(previous);
  }, []);

  const handleReset = useCallback(() => {
    undoHistoryRef.current = [];
    setFilterConfig(initialConfigRef.current);
  }, []);

  // Discovery data
  const { discovery } = useConnectorDiscovery(connectorId);

  // Filter preview (debounced)
  const { preview, isLoading } = useFilterPreview(connectorId, filterConfig);

  return (
    <div className="flex gap-4 h-full p-6">
      {/* Left panel — 60% */}
      <div className="basis-3/5 shrink-0 overflow-y-auto pr-4 border-r border-default">
        <ScopeControlsPanel
          indexId={indexId}
          connectorId={connectorId}
          isDraftMode={isDraftMode}
          discovery={discovery}
          filterConfig={filterConfig}
          onFilterChange={handleFilterChange}
        />
      </div>

      {/* Right panel — 40% */}
      <div className="basis-2/5 overflow-y-auto">
        <ScopePreviewPanel
          preview={preview}
          isLoading={isLoading}
          onUndo={handleUndo}
          onReset={handleReset}
          canUndo={undoHistoryRef.current.length > 0}
        />
      </div>
    </div>
  );
}
