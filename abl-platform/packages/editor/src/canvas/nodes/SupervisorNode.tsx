/**
 * Supervisor Node - Visual representation of a Supervisor DSL document
 */

import React from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode.js';
import type { SupervisorNodeData } from '../../types.js';

const SupervisorIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z" />
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

export const SupervisorNode: React.FC<NodeProps> = (props) => {
  const data = props.data as SupervisorNodeData;
  const doc = data.document;

  const agents = getDocProp<unknown[]>(doc, 'agents', []);
  const routing = getDocProp<unknown[]>(doc, 'routing', []);
  const intents = getDocProp<unknown[]>(doc, 'intents', []);
  const state = getDocProp<Record<string, unknown>>(doc, 'state', {});
  const communication = getDocProp<{ language?: string; formality?: string }>(
    doc,
    'communication',
    {},
  );

  const agentCount = agents?.length || 0;
  const routingCount = routing?.length || 0;
  const intentCount = intents?.length || 0;

  return (
    <BaseNode {...props} icon={<SupervisorIcon />} color="#8b5cf6" showTargetHandle={false}>
      <div className="supervisor-node-content">
        <div className="node-stats">
          <div className="stat">
            <span className="stat-value">{agentCount}</span>
            <span className="stat-label">Agents</span>
          </div>
          <div className="stat">
            <span className="stat-value">{routingCount}</span>
            <span className="stat-label">Routes</span>
          </div>
          <div className="stat">
            <span className="stat-value">{intentCount}</span>
            <span className="stat-label">Intents</span>
          </div>
        </div>

        {state && Object.keys(state).length > 0 && (
          <div className="node-section">
            <div className="section-title">State Variables</div>
            <div className="state-vars">
              {Object.entries(state)
                .slice(0, 3)
                .map(([ns, vars]) => (
                  <div key={ns} className="state-namespace">
                    <span className="namespace-name">{ns}.</span>
                    <span className="var-count">
                      {typeof vars === 'object' && vars ? Object.keys(vars as object).length : 0}{' '}
                      vars
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {communication && (communication.language || communication.formality) && (
          <div className="node-section">
            <div className="section-title">Communication</div>
            <div className="communication-info">
              {communication.language && <span>Lang: {communication.language}</span>}
              {communication.formality && <span>Style: {communication.formality}</span>}
            </div>
          </div>
        )}
      </div>
    </BaseNode>
  );
};

export default SupervisorNode;
