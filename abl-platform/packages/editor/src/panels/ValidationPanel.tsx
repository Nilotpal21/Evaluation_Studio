/**
 * Validation Panel - Display validation results and issues
 */

import React, { useCallback } from 'react';
import { useEditorStore, selectValidation } from '../store/editorStore.js';
import type { ValidationMessage } from '../types.js';

export interface ValidationPanelProps {
  className?: string;
  onIssueClick?: (message: ValidationMessage) => void;
}

const getSeverityIcon = (severity: ValidationMessage['severity']) => {
  switch (severity) {
    case 'error':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="#DC2626">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
        </svg>
      );
    case 'warning':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="#F59E0B">
          <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
        </svg>
      );
    case 'info':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="#3B82F6">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
        </svg>
      );
  }
};

const ValidationItem: React.FC<{
  message: ValidationMessage;
  onClick?: () => void;
}> = ({ message, onClick }) => {
  return (
    <div className={`validation-item ${message.severity}`} onClick={onClick}>
      <div className="item-icon">{getSeverityIcon(message.severity)}</div>
      <div className="item-content">
        <div className="item-message">{message.message}</div>
        {message.rule && <div className="item-rule">{message.rule}</div>}
        {message.suggestion && (
          <div className="item-suggestion">
            <span className="suggestion-label">Suggestion:</span> {message.suggestion}
          </div>
        )}
        {(message.nodeId || message.edgeId) && (
          <div className="item-location">
            {message.nodeId && <span className="location-node">Node: {message.nodeId}</span>}
            {message.edgeId && <span className="location-edge">Edge: {message.edgeId}</span>}
          </div>
        )}
      </div>
    </div>
  );
};

export const ValidationPanel: React.FC<ValidationPanelProps> = ({
  className = '',
  onIssueClick,
}) => {
  const validation = useEditorStore(selectValidation);
  const validate = useEditorStore((state) => state.validate);
  const clearValidation = useEditorStore((state) => state.clearValidation);
  const selectNode = useEditorStore((state) => state.selectNode);

  const handleIssueClick = useCallback(
    (message: ValidationMessage) => {
      if (message.nodeId) {
        selectNode(message.nodeId);
      }
      onIssueClick?.(message);
    },
    [selectNode, onIssueClick],
  );

  const errorCount = validation.errors.length;
  const warningCount = validation.warnings.length;
  const totalIssues = errorCount + warningCount;

  return (
    <div className={`validation-panel ${className}`}>
      <div className="panel-header">
        <div className="header-left">
          <h3>Validation</h3>
          <div className="validation-summary">
            {validation.isValid ? (
              <span className="status-valid">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="#10B981">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                </svg>
                Valid
              </span>
            ) : (
              <span className="status-invalid">
                {errorCount} errors, {warningCount} warnings
              </span>
            )}
          </div>
        </div>
        <div className="header-right">
          <button className="validate-button" onClick={validate} title="Run validation">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
            </svg>
          </button>
          <button
            className="clear-button"
            onClick={clearValidation}
            title="Clear results"
            disabled={totalIssues === 0}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
      </div>

      <div className="validation-content">
        {totalIssues === 0 ? (
          <div className="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="#10B981">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
            </svg>
            <p>No issues found</p>
            <span className="empty-hint">Click validate to check for issues</span>
          </div>
        ) : (
          <>
            {validation.errors.length > 0 && (
              <div className="issue-section errors">
                <div className="section-header">
                  <span className="section-title">Errors ({errorCount})</span>
                </div>
                <div className="issue-list">
                  {validation.errors.map((error, i) => (
                    <ValidationItem
                      key={`error-${i}`}
                      message={error}
                      onClick={() => handleIssueClick(error)}
                    />
                  ))}
                </div>
              </div>
            )}

            {validation.warnings.length > 0 && (
              <div className="issue-section warnings">
                <div className="section-header">
                  <span className="section-title">Warnings ({warningCount})</span>
                </div>
                <div className="issue-list">
                  {validation.warnings.map((warning, i) => (
                    <ValidationItem
                      key={`warning-${i}`}
                      message={warning}
                      onClick={() => handleIssueClick(warning)}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default ValidationPanel;
