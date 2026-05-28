/**
 * Guardrail Node - Visual representation of a guardrail definition
 */

import React from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode.js';
import type { GuardrailNodeData } from '../../types.js';

const GuardrailIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z" />
  </svg>
);

const getActionColor = (action: GuardrailNodeData['action']) => {
  const colors: Record<string, string> = {
    block: '#ef4444',
    warn: '#f59e0b',
    redact: '#8b5cf6',
  };
  return colors[action] || '#6b7280';
};

const getTypeIcon = (type: GuardrailNodeData['guardrailType']) => {
  const icons: Record<string, React.ReactNode> = {
    input: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
        <path d="M21 3.01H3c-1.1 0-2 .9-2 2V9h2V4.99h18v14.03H3V15H1v4.01c0 1.1.9 1.98 2 1.98h18c1.1 0 2-.88 2-1.98V5.01c0-1.1-.9-2-2-2zM1 11v2h8l-2.5 2.5L7.91 17 13 12 7.91 7l-1.41 1.5L9 11H1z" />
      </svg>
    ),
    output: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
        <path d="M21 3.01H3c-1.1 0-2 .9-2 2V9h2V4.99h18v14.03H3V15H1v4.01c0 1.1.9 1.98 2 1.98h18c1.1 0 2-.88 2-1.98V5.01c0-1.1-.9-2-2-2zM23 11h-8l2.5-2.5L16.09 7 11 12l5.09 5 1.41-1.5L15 13h8v-2z" />
      </svg>
    ),
    behavioral: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
      </svg>
    ),
  };
  return icons[type] || icons.input;
};

export const GuardrailNode: React.FC<NodeProps> = (props) => {
  const data = props.data as GuardrailNodeData;
  const actionColor = getActionColor(data.action);

  return (
    <BaseNode {...props} icon={<GuardrailIcon />} color="#10b981" showSourceHandle={false}>
      <div className="guardrail-node-content">
        <div className="guardrail-header">
          <span className="guardrail-type-icon">{getTypeIcon(data.guardrailType)}</span>
          <span className="guardrail-type">{data.guardrailType}</span>
        </div>

        <div className="guardrail-name">{data.guardrailName}</div>

        <div className="guardrail-action" style={{ color: actionColor }}>
          <span className="action-label">Action:</span>
          <span className="action-value">{data.action.toUpperCase()}</span>
        </div>
      </div>
    </BaseNode>
  );
};

export default GuardrailNode;
