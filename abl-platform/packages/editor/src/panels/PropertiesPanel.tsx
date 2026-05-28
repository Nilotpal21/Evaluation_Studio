/**
 * Properties Panel - Edit properties of selected nodes
 */

import React, { useCallback } from 'react';
import { useEditorStore, selectSelectedNodes } from '../store/editorStore.js';
import type { DSLNodeData } from '../types.js';

export interface PropertiesPanelProps {
  className?: string;
}

interface PropertyFieldProps {
  label: string;
  value: string | number | boolean | undefined;
  type?: 'text' | 'number' | 'checkbox' | 'select' | 'textarea';
  options?: { value: string; label: string }[];
  onChange: (value: string | number | boolean) => void;
  disabled?: boolean;
}

const PropertyField: React.FC<PropertyFieldProps> = ({
  label,
  value,
  type = 'text',
  options,
  onChange,
  disabled = false,
}) => {
  const id = `prop-${label.toLowerCase().replace(/\s+/g, '-')}`;

  if (type === 'checkbox') {
    return (
      <div className="property-field checkbox">
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
        />
        <label htmlFor={id}>{label}</label>
      </div>
    );
  }

  if (type === 'select' && options) {
    return (
      <div className="property-field">
        <label htmlFor={id}>{label}</label>
        <select
          id={id}
          value={String(value || '')}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (type === 'textarea') {
    return (
      <div className="property-field">
        <label htmlFor={id}>{label}</label>
        <textarea
          id={id}
          value={String(value || '')}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={4}
        />
      </div>
    );
  }

  return (
    <div className="property-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={type === 'number' ? Number(value) || 0 : String(value || '')}
        onChange={(e) => onChange(type === 'number' ? Number(e.target.value) : e.target.value)}
        disabled={disabled}
      />
    </div>
  );
};

export const PropertiesPanel: React.FC<PropertiesPanelProps> = ({ className = '' }) => {
  const selectedNodes = useEditorStore(selectSelectedNodes);
  const updateNode = useEditorStore((state) => state.updateNode);
  const pushHistory = useEditorStore((state) => state.pushHistory);

  const handlePropertyChange = useCallback(
    (nodeId: string, key: string, value: string | number | boolean) => {
      updateNode(nodeId, { [key]: value } as Partial<DSLNodeData>);
      pushHistory(`Updated ${key}`);
    },
    [updateNode, pushHistory],
  );

  if (selectedNodes.length === 0) {
    return (
      <div className={`properties-panel empty ${className}`}>
        <div className="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
          </svg>
          <p>Select a node to edit its properties</p>
        </div>
      </div>
    );
  }

  if (selectedNodes.length > 1) {
    return (
      <div className={`properties-panel multi-select ${className}`}>
        <div className="panel-header">
          <h3>Multiple Selection</h3>
          <span className="selection-count">{selectedNodes.length} nodes</span>
        </div>
        <div className="multi-select-info">
          <p>Select a single node to edit properties</p>
          <ul className="selected-list">
            {selectedNodes.map((node) => (
              <li key={node.id}>
                <span className="node-type">{node.type}</span>
                <span className="node-label">{node.data.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  const node = selectedNodes[0];
  const data = node.data;

  return (
    <div className={`properties-panel ${className}`}>
      <div className="panel-header">
        <h3>{node.type}</h3>
        <span className="node-id">{node.id}</span>
      </div>

      <div className="properties-content">
        {/* Common properties */}
        <div className="property-section">
          <h4>General</h4>
          <PropertyField
            label="Label"
            value={data.label}
            onChange={(v) => handlePropertyChange(node.id, 'label', v)}
          />
          <PropertyField
            label="Description"
            value={data.description}
            type="textarea"
            onChange={(v) => handlePropertyChange(node.id, 'description', v)}
          />
        </div>

        {/* Type-specific properties */}
        {node.type === 'step' && (
          <div className="property-section">
            <h4>Step Properties</h4>
            <PropertyField
              label="Step Number"
              value={(data as any).stepNumber}
              onChange={(v) => handlePropertyChange(node.id, 'stepNumber', v)}
            />
            <PropertyField
              label="Action"
              value={(data as any).action}
              type="select"
              options={[
                { value: 'RESPOND', label: 'RESPOND' },
                { value: 'WAIT_INPUT', label: 'WAIT_INPUT' },
                { value: 'CALL', label: 'CALL' },
                { value: 'SET', label: 'SET' },
                { value: 'IF', label: 'IF' },
                { value: 'GOTO', label: 'GOTO' },
                { value: 'SIGNAL', label: 'SIGNAL' },
              ]}
              onChange={(v) => handlePropertyChange(node.id, 'action', v)}
            />
            <PropertyField
              label="Content"
              value={(data as any).content}
              type="textarea"
              onChange={(v) => handlePropertyChange(node.id, 'content', v)}
            />
          </div>
        )}

        {node.type === 'routing-rule' && (
          <div className="property-section">
            <h4>Routing Properties</h4>
            <PropertyField
              label="Priority"
              value={(data as any).priority}
              type="number"
              onChange={(v) => handlePropertyChange(node.id, 'priority', v)}
            />
            <PropertyField
              label="Condition"
              value={(data as any).condition}
              onChange={(v) => handlePropertyChange(node.id, 'condition', v)}
            />
            <PropertyField
              label="Target"
              value={(data as any).target}
              onChange={(v) => handlePropertyChange(node.id, 'target', v)}
            />
          </div>
        )}

        {node.type === 'guardrail' && (
          <div className="property-section">
            <h4>Guardrail Properties</h4>
            <PropertyField
              label="Name"
              value={(data as any).guardrailName}
              onChange={(v) => handlePropertyChange(node.id, 'guardrailName', v)}
            />
            <PropertyField
              label="Type"
              value={(data as any).guardrailType}
              type="select"
              options={[
                { value: 'input', label: 'Input' },
                { value: 'output', label: 'Output' },
                { value: 'behavioral', label: 'Behavioral' },
              ]}
              onChange={(v) => handlePropertyChange(node.id, 'guardrailType', v)}
            />
            <PropertyField
              label="Action"
              value={(data as any).action}
              type="select"
              options={[
                { value: 'block', label: 'Block' },
                { value: 'warn', label: 'Warn' },
                { value: 'redact', label: 'Redact' },
              ]}
              onChange={(v) => handlePropertyChange(node.id, 'action', v)}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default PropertiesPanel;
