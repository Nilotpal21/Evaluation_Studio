/**
 * ABL Editor - Main editor component combining all pieces
 */

import React, { useCallback, useEffect, useMemo } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useEditorStore } from '../store/editorStore.js';
import { ABLCanvas } from '../canvas/ABLCanvas.js';
import { Toolbar } from './Toolbar.js';
import { NodePalette } from './NodePalette.js';
import { PropertiesPanel } from '../panels/PropertiesPanel.js';
import { CodeEditorPanel } from '../panels/CodeEditorPanel.js';
import { ValidationPanel } from '../panels/ValidationPanel.js';
import type { BaseNodeData, ExportOptions, EditorProject } from '../types.js';

export interface ABLEditorProps {
  className?: string;
  project?: EditorProject;
  onProjectChange?: (project: EditorProject) => void;
  onExport?: (options: ExportOptions) => void;
  onImport?: (content: string) => void;
}

export const ABLEditor: React.FC<ABLEditorProps> = ({
  className = '',
  project,
  onProjectChange,
  onExport,
  onImport,
}) => {
  const viewMode = useEditorStore((state) => state.viewMode);
  const panels = useEditorStore((state) => state.panels);
  const storeProject = useEditorStore((state) => state.project);
  const loadProject = useEditorStore((state) => state.loadProject);
  const saveProject = useEditorStore((state) => state.saveProject);
  const togglePanel = useEditorStore((state) => state.togglePanel);

  // Sync external project with store
  useEffect(() => {
    if (project && project !== storeProject) {
      loadProject(project);
    }
  }, [project, storeProject, loadProject]);

  // Handle node double click
  const handleNodeDoubleClick = useCallback(
    (nodeId: string, data: BaseNodeData) => {
      // Open properties panel for editing
      if (!panels.properties?.isOpen) {
        togglePanel('properties');
      }
      // Could also open code panel to that node's code
    },
    [panels, togglePanel],
  );

  // Handle export
  const handleExport = useCallback(() => {
    if (onExport) {
      onExport({ format: 'abl' });
    }
  }, [onExport]);

  // Handle import
  const handleImport = useCallback(() => {
    // Create file input
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.abl,.json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const content = e.target?.result as string;
          if (onImport) {
            onImport(content);
          }
        };
        reader.readAsText(file);
      }
    };
    input.click();
  }, [onImport]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      if (isMod && e.key === 's') {
        e.preventDefault();
        saveProject();
      }

      if (isMod && e.key === '1') {
        e.preventDefault();
        togglePanel('outline');
      }

      if (isMod && e.key === '2') {
        e.preventDefault();
        togglePanel('properties');
      }

      if (isMod && e.key === '3') {
        e.preventDefault();
        togglePanel('code');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveProject, togglePanel]);

  // Layout classes based on view mode
  const layoutClass = useMemo(() => {
    switch (viewMode) {
      case 'graph':
        return 'layout-graph';
      case 'code':
        return 'layout-code';
      case 'split':
        return 'layout-split';
      default:
        return 'layout-graph';
    }
  }, [viewMode]);

  return (
    <ReactFlowProvider>
      <div className={`abl-editor ${layoutClass} ${className}`}>
        <Toolbar className="editor-toolbar" onExport={handleExport} onImport={handleImport} />

        <div className="editor-main">
          {/* Left Panel - Palette/Outline */}
          {panels.outline?.isOpen && (
            <div className="editor-panel left" style={{ width: panels.outline.width }}>
              <NodePalette />
            </div>
          )}

          {/* Center - Canvas and/or Code */}
          <div className="editor-center">
            {(viewMode === 'graph' || viewMode === 'split') && (
              <div className="canvas-container">
                <ABLCanvas className="main-canvas" onNodeDoubleClick={handleNodeDoubleClick} />
              </div>
            )}

            {(viewMode === 'code' || viewMode === 'split') && (
              <div className="code-container">
                <CodeEditorPanel height="100%" />
              </div>
            )}
          </div>

          {/* Right Panel - Properties */}
          {panels.properties?.isOpen && (
            <div className="editor-panel right" style={{ width: panels.properties.width }}>
              <PropertiesPanel />
            </div>
          )}
        </div>

        {/* Bottom Panel - Validation */}
        {panels.validation?.isOpen && (
          <div className="editor-panel bottom">
            <ValidationPanel />
          </div>
        )}
      </div>
    </ReactFlowProvider>
  );
};

export default ABLEditor;
