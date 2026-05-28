/**
 * Code Editor Panel - Monaco editor for DSL code
 */

import React, { useCallback, useEffect } from 'react';
import { useEditorStore } from '../store/editorStore.js';

export interface CodeEditorPanelProps {
  className?: string;
  height?: string | number;
}

// Simple textarea-based editor as fallback
// Monaco integration would be added when the full app is built
export const CodeEditorPanel: React.FC<CodeEditorPanelProps> = ({
  className = '',
  height = '100%',
}) => {
  const content = useEditorStore((state) => state.codeEditor.content);
  const language = useEditorStore((state) => state.codeEditor.language);
  const isDirty = useEditorStore((state) => state.codeEditor.isDirty);

  const setCodeContent = useEditorStore((state) => state.setCodeContent);
  const setCodeLanguage = useEditorStore((state) => state.setCodeLanguage);
  const syncCodeToCanvas = useEditorStore((state) => state.syncCodeToCanvas);

  // Handle content change
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setCodeContent(e.target.value);
    },
    [setCodeContent],
  );

  // Sync to canvas shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        syncCodeToCanvas();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [syncCodeToCanvas]);

  return (
    <div className={`code-editor-panel ${className}`}>
      <div className="panel-header">
        <div className="header-left">
          <h3>Code Editor</h3>
          {isDirty && <span className="dirty-indicator">●</span>}
        </div>
        <div className="header-right">
          <select
            value={language}
            onChange={(e) => setCodeLanguage(e.target.value as 'dsl' | 'python' | 'json')}
            className="language-selector"
          >
            <option value="dsl">DSL</option>
            <option value="python">Python</option>
            <option value="json">JSON</option>
          </select>
          <button className="sync-button" onClick={syncCodeToCanvas} title="Sync to canvas (Cmd+S)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
            </svg>
          </button>
        </div>
      </div>

      <div className="editor-container" style={{ height }}>
        <textarea
          className="code-textarea"
          value={content}
          onChange={handleChange}
          placeholder={`Enter ${language.toUpperCase()} code here...`}
          spellCheck={false}
          style={{
            width: '100%',
            height: '100%',
            fontFamily: 'SF Mono, SFMono-Regular, ui-monospace, monospace',
            fontSize: '14px',
            lineHeight: '1.5',
            padding: '12px',
            border: 'none',
            outline: 'none',
            resize: 'none',
            backgroundColor: '#fafafa',
          }}
        />
      </div>
    </div>
  );
};

export default CodeEditorPanel;
