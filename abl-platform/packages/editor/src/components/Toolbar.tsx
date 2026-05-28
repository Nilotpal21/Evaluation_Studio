/**
 * Toolbar - Main toolbar for the editor
 */

import React from 'react';
import {
  useEditorStore,
  selectCanUndo,
  selectCanRedo,
  selectIsDirty,
} from '../store/editorStore.js';
import type { ViewMode } from '../types.js';

export interface ToolbarProps {
  className?: string;
  onExport?: () => void;
  onImport?: () => void;
}

export const Toolbar: React.FC<ToolbarProps> = ({ className = '', onExport, onImport }) => {
  const project = useEditorStore((state) => state.project);
  const viewMode = useEditorStore((state) => state.viewMode);
  const showGrid = useEditorStore((state) => state.showGrid);
  const showMinimap = useEditorStore((state) => state.showMinimap);
  const canUndo = useEditorStore(selectCanUndo);
  const canRedo = useEditorStore(selectCanRedo);
  const isDirty = useEditorStore(selectIsDirty);
  const isSaving = useEditorStore((state) => state.isSaving);

  const setViewMode = useEditorStore((state) => state.setViewMode);
  const toggleGrid = useEditorStore((state) => state.toggleGrid);
  const toggleMinimap = useEditorStore((state) => state.toggleMinimap);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const saveProject = useEditorStore((state) => state.saveProject);
  const zoomIn = useEditorStore((state) => state.zoomIn);
  const zoomOut = useEditorStore((state) => state.zoomOut);
  const resetZoom = useEditorStore((state) => state.resetZoom);
  const validate = useEditorStore((state) => state.validate);

  return (
    <div className={`editor-toolbar ${className}`}>
      {/* Project Info */}
      <div className="toolbar-section project-info">
        <span className="project-name">{project?.name || 'Untitled'}</span>
        {isDirty && <span className="dirty-indicator">●</span>}
      </div>

      {/* File Actions */}
      <div className="toolbar-section file-actions">
        <button
          className="toolbar-button"
          onClick={saveProject}
          disabled={!isDirty || isSaving}
          title="Save (Cmd+S)"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z" />
          </svg>
          {isSaving ? 'Saving...' : 'Save'}
        </button>

        <button className="toolbar-button" onClick={onImport} title="Import DSL">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z" />
          </svg>
        </button>

        <button className="toolbar-button" onClick={onExport} title="Export">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
          </svg>
        </button>
      </div>

      <div className="toolbar-divider" />

      {/* Edit Actions */}
      <div className="toolbar-section edit-actions">
        <button
          className="toolbar-button icon-only"
          onClick={undo}
          disabled={!canUndo}
          title="Undo (Cmd+Z)"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" />
          </svg>
        </button>

        <button
          className="toolbar-button icon-only"
          onClick={redo}
          disabled={!canRedo}
          title="Redo (Cmd+Shift+Z)"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z" />
          </svg>
        </button>
      </div>

      <div className="toolbar-divider" />

      {/* View Mode */}
      <div className="toolbar-section view-mode">
        <div className="button-group">
          <button
            className={`toolbar-button ${viewMode === 'graph' ? 'active' : ''}`}
            onClick={() => setViewMode('graph')}
            title="Graph View"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z" />
            </svg>
          </button>

          <button
            className={`toolbar-button ${viewMode === 'code' ? 'active' : ''}`}
            onClick={() => setViewMode('code')}
            title="Code View"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z" />
            </svg>
          </button>

          <button
            className={`toolbar-button ${viewMode === 'split' ? 'active' : ''}`}
            onClick={() => setViewMode('split')}
            title="Split View"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 5v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2zm8 14H5V5h6v14zm8 0h-6V5h6v14z" />
            </svg>
          </button>
        </div>
      </div>

      <div className="toolbar-divider" />

      {/* Canvas Controls */}
      <div className="toolbar-section canvas-controls">
        <button className="toolbar-button icon-only" onClick={zoomOut} title="Zoom Out">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zM7 9h5v1H7z" />
          </svg>
        </button>

        <button className="toolbar-button icon-only" onClick={resetZoom} title="Reset Zoom">
          100%
        </button>

        <button className="toolbar-button icon-only" onClick={zoomIn} title="Zoom In">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zm.5-7H9v2H7v1h2v2h1v-2h2V9h-2z" />
          </svg>
        </button>

        <button
          className={`toolbar-button icon-only ${showGrid ? 'active' : ''}`}
          onClick={toggleGrid}
          title="Toggle Grid"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM8 20H4v-4h4v4zm0-6H4v-4h4v4zm0-6H4V4h4v4zm6 12h-4v-4h4v4zm0-6h-4v-4h4v4zm0-6h-4V4h4v4zm6 12h-4v-4h4v4zm0-6h-4v-4h4v4zm0-6h-4V4h4v4z" />
          </svg>
        </button>

        <button
          className={`toolbar-button icon-only ${showMinimap ? 'active' : ''}`}
          onClick={toggleMinimap}
          title="Toggle Minimap"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z" />
          </svg>
        </button>
      </div>

      <div className="toolbar-divider" />

      {/* Actions */}
      <div className="toolbar-section actions">
        <button className="toolbar-button" onClick={validate} title="Validate">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z" />
          </svg>
          Validate
        </button>
      </div>
    </div>
  );
};

export default Toolbar;
