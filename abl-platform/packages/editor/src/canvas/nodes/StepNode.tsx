/**
 * Step Node - Visual representation of an agent step
 */

import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode.js';
import type { StepNodeData } from '../../types.js';

const getStepIcon = (action: StepNodeData['action']) => {
  const icons: Record<string, React.ReactNode> = {
    RESPOND: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
      </svg>
    ),
    WAIT_INPUT: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
      </svg>
    ),
    CALL: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17 1H7c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-2-2-2zm0 18H7V5h10v14z" />
      </svg>
    ),
    SET: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z" />
      </svg>
    ),
    IF: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2l-5.5 9h11L12 2zm0 3.84L13.93 9h-3.87L12 5.84zM17.5 13c-2.49 0-4.5 2.01-4.5 4.5s2.01 4.5 4.5 4.5 4.5-2.01 4.5-4.5-2.01-4.5-4.5-4.5zm0 7c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5zM3 21.5h8v-8H3v8zm2-6h4v4H5v-4z" />
      </svg>
    ),
    GOTO: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z" />
      </svg>
    ),
    SIGNAL: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M7.77 6.76L6.23 5.48.82 12l5.41 6.52 1.54-1.28L3.42 12l4.35-5.24zM7 13h2v-2H7v2zm10-2h-2v2h2v-2zm-6 2h2v-2h-2v2zm6.77-7.52l-1.54 1.28L20.58 12l-4.35 5.24 1.54 1.28L23.18 12l-5.41-6.52z" />
      </svg>
    ),
  };
  return icons[action] || icons.RESPOND;
};

const getStepColor = (action: StepNodeData['action']) => {
  const colors: Record<string, string> = {
    RESPOND: '#3b82f6',
    WAIT_INPUT: '#f59e0b',
    CALL: '#8b5cf6',
    SET: '#10b981',
    IF: '#ec4899',
    GOTO: '#6366f1',
    SIGNAL: '#ef4444',
  };
  return colors[action] || '#6b7280';
};

export const StepNode: React.FC<NodeProps> = (props) => {
  const data = props.data as StepNodeData;
  const color = getStepColor(data.action);

  return (
    <BaseNode {...props} icon={getStepIcon(data.action)} color={color}>
      <div className="step-node-content">
        <div className="step-number">{data.stepNumber}</div>
        <div className="step-action">{data.action}</div>
        {data.content && (
          <div className="step-content">
            {data.content.length > 50 ? data.content.substring(0, 50) + '...' : data.content}
          </div>
        )}
      </div>

      {/* Conditional handles for branching */}
      {data.action === 'IF' && (
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="true"
            className="dsl-handle condition-true"
            style={{ top: '30%' }}
          />
          <Handle
            type="source"
            position={Position.Right}
            id="false"
            className="dsl-handle condition-false"
            style={{ top: '70%' }}
          />
        </>
      )}

      {data.action === 'WAIT_INPUT' && (
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="positive"
            className="dsl-handle input-positive"
            style={{ top: '25%' }}
          />
          <Handle
            type="source"
            position={Position.Right}
            id="negative"
            className="dsl-handle input-negative"
            style={{ top: '50%' }}
          />
          <Handle
            type="source"
            position={Position.Right}
            id="default"
            className="dsl-handle input-default"
            style={{ top: '75%' }}
          />
        </>
      )}
    </BaseNode>
  );
};

export default StepNode;
