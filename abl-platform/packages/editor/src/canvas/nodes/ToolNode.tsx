/**
 * Tool Node - Visual representation of a tool definition
 */

import React from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode.js';
import type { ToolNodeData } from '../../types.js';

const ToolIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z" />
  </svg>
);

export const ToolNode: React.FC<NodeProps> = (props) => {
  const data = props.data as ToolNodeData;

  return (
    <BaseNode {...props} icon={<ToolIcon />} color="#8b5cf6" showSourceHandle={false}>
      <div className="tool-node-content">
        <div className="tool-signature">
          <span className="tool-name">{data.toolName}</span>
          <span className="tool-params">({data.parameters.map((p) => p.name).join(', ')})</span>
        </div>

        {data.parameters.length > 0 && (
          <div className="tool-parameters">
            {data.parameters.map((param, i) => (
              <div key={i} className="param-item">
                <span className="param-name">{param.name}</span>
                <span className="param-type">{param.type}</span>
              </div>
            ))}
          </div>
        )}

        {data.returnType && (
          <div className="tool-return">
            <span className="return-label">Returns:</span>
            <span className="return-type">{data.returnType}</span>
          </div>
        )}
      </div>
    </BaseNode>
  );
};

export default ToolNode;
