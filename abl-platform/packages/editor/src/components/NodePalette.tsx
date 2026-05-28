/**
 * Node Palette - Drag and drop palette for adding nodes
 */

import React, { useCallback } from 'react';
import type { DSLNodeType, DragItem } from '../types.js';

export interface PaletteItem {
  type: DSLNodeType;
  label: string;
  icon: React.ReactNode;
  description: string;
  category: 'structure' | 'flow' | 'behavior';
}

const paletteItems: PaletteItem[] = [
  {
    type: 'supervisor',
    label: 'Supervisor',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z" />
      </svg>
    ),
    description: 'Main orchestrator for routing',
    category: 'structure',
  },
  {
    type: 'agent',
    label: 'Agent',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
      </svg>
    ),
    description: 'Task-focused agent',
    category: 'structure',
  },
  {
    type: 'step',
    label: 'Step',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z" />
      </svg>
    ),
    description: 'Agent workflow step',
    category: 'flow',
  },
  {
    type: 'routing-rule',
    label: 'Routing Rule',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M14 6l-1 2H7v2h5l-1 2H5v2h5l-1 2H3v2h16v-2H9l1-2h8v-2h-7l1-2h7V8h-6l1-2h5V4H3v2h11z" />
      </svg>
    ),
    description: 'Conditional routing',
    category: 'flow',
  },
  {
    type: 'tool',
    label: 'Tool',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z" />
      </svg>
    ),
    description: 'External tool call',
    category: 'behavior',
  },
  {
    type: 'guardrail',
    label: 'Guardrail',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z" />
      </svg>
    ),
    description: 'Input/output guard',
    category: 'behavior',
  },
];

export interface NodePaletteProps {
  className?: string;
}

export const NodePalette: React.FC<NodePaletteProps> = ({ className = '' }) => {
  const handleDragStart = useCallback((event: React.DragEvent, item: PaletteItem) => {
    const dragData: DragItem = {
      type: item.type,
      data: {
        label: `New ${item.label}`,
        type: item.type,
      },
    };
    event.dataTransfer.setData('application/dsl-node', JSON.stringify(dragData));
    event.dataTransfer.effectAllowed = 'move';
  }, []);

  const groupedItems = paletteItems.reduce(
    (acc, item) => {
      if (!acc[item.category]) {
        acc[item.category] = [];
      }
      acc[item.category].push(item);
      return acc;
    },
    {} as Record<string, PaletteItem[]>,
  );

  const categoryLabels: Record<string, string> = {
    structure: 'Structure',
    flow: 'Flow',
    behavior: 'Behavior',
  };

  return (
    <div className={`node-palette ${className}`}>
      <div className="palette-header">
        <h3>Components</h3>
        <span className="hint">Drag to canvas</span>
      </div>

      <div className="palette-content">
        {Object.entries(groupedItems).map(([category, items]) => (
          <div key={category} className="palette-category">
            <div className="category-header">{categoryLabels[category]}</div>
            <div className="category-items">
              {items.map((item) => (
                <div
                  key={item.type}
                  className="palette-item"
                  draggable
                  onDragStart={(e) => handleDragStart(e, item)}
                >
                  <div className="item-icon">{item.icon}</div>
                  <div className="item-info">
                    <div className="item-label">{item.label}</div>
                    <div className="item-description">{item.description}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default NodePalette;
