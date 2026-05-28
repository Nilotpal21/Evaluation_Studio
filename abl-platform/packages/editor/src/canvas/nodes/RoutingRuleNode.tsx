/**
 * Routing Rule Node - Visual representation of a routing rule
 */

import React from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode.js';
import type { RoutingRuleNodeData } from '../../types.js';

const RoutingIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M14 6l-1 2H7v2h5l-1 2H5v2h5l-1 2H3v2h16v-2H9l1-2h8v-2h-7l1-2h7V8h-6l1-2h5V4H3v2h11z" />
  </svg>
);

export const RoutingRuleNode: React.FC<NodeProps> = (props) => {
  const data = props.data as RoutingRuleNodeData;

  const getPriorityColor = (priority: number) => {
    if (priority === 0) return '#ef4444';
    if (priority <= 2) return '#f59e0b';
    if (priority <= 4) return '#10b981';
    return '#6b7280';
  };

  return (
    <BaseNode
      {...props}
      icon={<RoutingIcon />}
      color="#f97316"
      headerContent={
        <span
          className="priority-badge"
          style={{ backgroundColor: getPriorityColor(data.priority) }}
        >
          P{data.priority}
        </span>
      }
    >
      <div className="routing-node-content">
        <div className="routing-condition">
          <span className="condition-label">When:</span>
          <code className="condition-code">{data.condition}</code>
        </div>

        <div className="routing-target">
          <span className="target-label">Route to:</span>
          <span className="target-value">{data.target}</span>
        </div>

        {data.flags && data.flags.length > 0 && (
          <div className="routing-flags">
            {data.flags.map((flag, i) => (
              <span key={i} className="flag-tag">
                {flag}
              </span>
            ))}
          </div>
        )}
      </div>
    </BaseNode>
  );
};

export default RoutingRuleNode;
