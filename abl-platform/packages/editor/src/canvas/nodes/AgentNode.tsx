/**
 * Agent Node - Visual representation of an Agent DSL document
 */

import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode.js';
import type { AgentNodeData } from '../../types.js';

const AgentIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
  </svg>
);

// Helper to safely access document properties
function getDocProp<T>(doc: unknown, path: string, defaultValue: T): T {
  if (!doc || typeof doc !== 'object') return defaultValue;
  const parts = path.split('.');
  let current: unknown = doc;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return defaultValue;
    }
  }
  return current as T;
}

export const AgentNode: React.FC<NodeProps> = (props) => {
  const data = props.data as AgentNodeData;
  const doc = data.document;

  const flow = getDocProp<unknown[]>(doc, 'flow', []);
  const tools = getDocProp<unknown[]>(doc, 'tools', []);
  const guardrails = getDocProp<unknown[]>(doc, 'guardrails', []);
  const identity = getDocProp<{ role?: string; expertise?: string[] }>(doc, 'identity', {});
  const contract = getDocProp<{
    inputs?: Record<string, unknown>;
    outputs?: Record<string, unknown>;
  }>(doc, 'contract', {});

  const stepCount = flow?.length || 0;
  const toolCount = tools?.length || 0;
  const guardrailCount = guardrails?.length || 0;

  return (
    <BaseNode
      {...props}
      icon={<AgentIcon />}
      color={data.isActive ? '#10b981' : '#6366f1'}
      headerContent={data.isActive && <span className="active-badge">Active</span>}
    >
      <div className="agent-node-content">
        {identity && identity.role && (
          <div className="node-section identity-section">
            <div className="identity-role">{identity.role}</div>
            {identity.expertise && identity.expertise.length > 0 && (
              <div className="expertise-tags">
                {identity.expertise.slice(0, 3).map((exp: string, i: number) => (
                  <span key={i} className="expertise-tag">
                    {exp}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="node-stats">
          <div className="stat">
            <span className="stat-value">{stepCount}</span>
            <span className="stat-label">Steps</span>
          </div>
          <div className="stat">
            <span className="stat-value">{toolCount}</span>
            <span className="stat-label">Tools</span>
          </div>
          <div className="stat">
            <span className="stat-value">{guardrailCount}</span>
            <span className="stat-label">Guards</span>
          </div>
        </div>

        {contract && (contract.inputs || contract.outputs) && (
          <div className="node-section contract-section">
            <div className="section-title">Contract</div>
            <div className="contract-io">
              <div className="io-item">
                <span className="io-label">In:</span>
                <span className="io-count">
                  {contract.inputs ? Object.keys(contract.inputs).length : 0}
                </span>
              </div>
              <div className="io-item">
                <span className="io-label">Out:</span>
                <span className="io-count">
                  {contract.outputs ? Object.keys(contract.outputs).length : 0}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Extra handles for step connections */}
      <Handle
        type="source"
        position={Position.Right}
        id="steps"
        className="dsl-handle steps"
        style={{ top: '50%' }}
      />
    </BaseNode>
  );
};

export default AgentNode;
