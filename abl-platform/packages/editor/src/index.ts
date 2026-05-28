/**
 * @abl/editor - Visual editor for Agent ABL
 *
 * This package provides a React-based visual editor for creating and editing
 * Agent ABL documents using a node-based interface powered by React Flow.
 */

// Main editor component
export { ABLEditor } from './components/ABLEditor.js';
export type { ABLEditorProps } from './components/ABLEditor.js';

// Individual components
export { Toolbar } from './components/Toolbar.js';
export { NodePalette } from './components/NodePalette.js';

// Canvas
export { ABLCanvas } from './canvas/ABLCanvas.js';
export { nodeTypes } from './canvas/nodes/index.js';

// Panels
export { PropertiesPanel } from './panels/PropertiesPanel.js';
export { CodeEditorPanel } from './panels/CodeEditorPanel.js';
export { ValidationPanel } from './panels/ValidationPanel.js';

// Store
export { useEditorStore } from './store/editorStore.js';
export type { EditorState } from './store/editorStore.js';

// Types
export type {
  DSLNodeType,
  DSLNodeData,
  DSLNode,
  DSLEdge,
  DSLEdgeType,
  DSLEdgeData,
  EditorProject,
  PanelType,
  PanelState,
  ViewMode,
  SelectionState,
  DragItem,
  CodeEditorState,
  ValidationResult,
  ValidationMessage,
  CanvasTransform,
  HistoryEntry,
  ExportOptions,
  // Node data types
  BaseNodeData,
  SupervisorNodeData,
  AgentNodeData,
  StepNodeData,
  RoutingRuleNodeData,
  ToolNodeData,
  GuardrailNodeData,
  StateVariableNodeData,
  IntentGroupNodeData,
} from './types.js';

// Utilities
export { supervisorToNodes, agentToNodes, nodesToDocuments } from './utils/conversion.js';
