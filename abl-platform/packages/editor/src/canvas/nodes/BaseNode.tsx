/**
 * Base Node Component - Foundation for all DSL nodes
 */

import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { BaseNodeData } from '../../types.js';

export interface BaseNodeProps extends NodeProps {
  children: React.ReactNode;
  icon?: React.ReactNode;
  color?: string;
  showSourceHandle?: boolean;
  showTargetHandle?: boolean;
  headerContent?: React.ReactNode;
}

export const BaseNode: React.FC<BaseNodeProps> = ({
  children,
  icon,
  color = '#6366f1',
  showSourceHandle = true,
  showTargetHandle = true,
  headerContent,
  selected,
  data,
}) => {
  const nodeData = data as BaseNodeData;
  const hasErrors = nodeData.errors && nodeData.errors.length > 0;
  const hasWarnings = nodeData.warnings && nodeData.warnings.length > 0;

  return (
    <div
      className={`dsl-node ${selected ? 'selected' : ''} ${hasErrors ? 'has-errors' : ''}`}
      style={{
        borderColor: hasErrors ? '#ef4444' : hasWarnings ? '#f59e0b' : color,
        borderWidth: selected ? 2 : 1,
      }}
    >
      {showTargetHandle && (
        <Handle type="target" position={Position.Top} className="dsl-handle target" />
      )}

      <div className="dsl-node-header" style={{ backgroundColor: color }}>
        {icon && <span className="dsl-node-icon">{icon}</span>}
        <span className="dsl-node-label">{nodeData.label}</span>
        {headerContent}
      </div>

      <div className="dsl-node-content">{children}</div>

      {nodeData.description && <div className="dsl-node-description">{nodeData.description}</div>}

      {hasErrors && (
        <div className="dsl-node-errors">
          {nodeData.errors!.map((err, i) => (
            <div key={i} className="dsl-node-error">
              {err}
            </div>
          ))}
        </div>
      )}

      {showSourceHandle && (
        <Handle type="source" position={Position.Bottom} className="dsl-handle source" />
      )}
    </div>
  );
};

export default BaseNode;
