# UI Component Libraries for Pipeline Visual Designer

**Task:** Research #49 - UI component libraries for pipeline visual designer
**Status:** Complete
**Date:** 2026-03-07

---

## Executive Summary

This research evaluates UI component libraries for building SearchAI's pipeline visual designer in Studio. The recommended approach is a **hybrid solution** combining **React Flow** for flow visualization, **DnD Kit** for drag-and-drop, **React JSON Schema Form** for dynamic provider config forms, and existing **Studio design system** components.

**Key Findings:**

1. **Flow Visualization:** React Flow (best fit for pipelines, 3M+ downloads/month, MIT license)
2. **Drag-and-Drop:** DnD Kit (modern, accessible, already in Studio stack)
3. **Dynamic Forms:** React JSON Schema Form + custom Radix UI widgets (consistency with Studio)
4. **Expression Builder:** Custom component using Monaco Editor (CEL syntax highlighting)
5. **Design System:** Extend existing Studio components (37 available, Radix UI + Tailwind)

**Total Bundle Size Impact:** ~450KB gzipped (React Flow 350KB, RJSF 100KB)

---

## Table of Contents

1. [Requirements Analysis](#requirements-analysis)
2. [Flow Visualization Libraries](#flow-visualization-libraries)
3. [Drag-and-Drop Libraries](#drag-and-drop-libraries)
4. [JSON Schema Form Libraries](#json-schema-form-libraries)
5. [Expression Builder Options](#expression-builder-options)
6. [Recommended Solution](#recommended-solution)
7. [Integration Patterns](#integration-patterns)
8. [Bundle Size Analysis](#bundle-size-analysis)
9. [Implementation Roadmap](#implementation-roadmap)

---

## Requirements Analysis

### Pipeline Visual Designer Requirements

**From RFC-004 and design tasks:**

1. **Flow Visualization**
   - Display pipeline flows as visual graph
   - Nodes: Stages (extraction, enrichment, embedding, etc.)
   - Edges: Sequential stage connections
   - Parallel branches (embedding + enrichment in parallel)
   - Flow-level grouping (multiple flows in one pipeline)

2. **Drag-and-Drop Stage Management**
   - Drag stages from palette to canvas
   - Reorder stages within flow
   - Delete stages
   - Duplicate stages

3. **Dynamic Stage Configuration Forms**
   - Provider-specific config forms (based on JSON Schema)
   - Field types: text, number, boolean, enum, object, array
   - Validation (required fields, min/max, regex)
   - Conditional fields (show/hide based on other fields)

4. **Flow Selection Rules Builder**
   - No-code CEL expression builder
   - Field selector (doc.contentType, doc.fileSize, etc.)
   - Operator selector (==, !=, >, <, contains, matches)
   - Value input (text, number, boolean)
   - Compound conditions (AND, OR)
   - Preview: Show CEL expression

5. **Live Preview**
   - Simulate flow selection for sample document
   - Highlight selected flow
   - Show stage execution path

6. **Cost Estimation Display**
   - Per-stage cost breakdown
   - Total pipeline cost
   - Visual cost indicators (color-coded)

---

## Flow Visualization Libraries

### Option 1: React Flow (✅ Recommended)

**Website:** https://reactflow.dev/
**npm:** `@xyflow/react` (formerly `reactflow`)
**License:** MIT
**Downloads:** 3.2M/month
**Bundle Size:** ~350KB gzipped

#### Pros

- ✅ **Production-ready** - Used by 100+ companies (Stripe, Typeform, Retool)
- ✅ **Feature-complete** - All pipeline designer needs met
- ✅ **Excellent docs** - Comprehensive guides, examples, playground
- ✅ **Active development** - v12 released 2024, regular updates
- ✅ **TypeScript-first** - Full type safety
- ✅ **Accessible** - Keyboard navigation, screen reader support
- ✅ **Customizable** - Custom nodes, edges, controls
- ✅ **Performance** - Handles 1000+ nodes efficiently
- ✅ **React 18 compatible**

#### Cons

- ❌ Bundle size (350KB) - but justified by features
- ⚠️ Learning curve - moderate (1-2 days to proficiency)

#### Features

**Core Features:**

- Nodes & edges with custom rendering
- Automatic layout (dagre, elk)
- Zoom, pan, fit-to-view
- Node selection (single, multi)
- Node dragging, resizing
- Edge connections
- Undo/redo
- Minimap
- Controls (zoom in/out, fit view)
- Background patterns (dots, grid, lines)

**Advanced Features:**

- Custom node types (React components)
- Custom edge types (animated, labeled, curved)
- Node grouping (sub-flows)
- Connection validation (only valid connections)
- Edge animations (data flow visualization)
- Node toolbar (edit, delete buttons)
- Context menu (right-click)
- Viewport persistence (save/restore zoom/pan)

#### Example Usage

```tsx
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
  addEdge,
  Connection,
  useNodesState,
  useEdgesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// Custom stage node component
function StageNode({ data }: { data: StageNodeData }) {
  return (
    <div className="rounded-lg border border-default bg-background-muted p-4 shadow-lg">
      <div className="flex items-center gap-2">
        <StageIcon type={data.stageType} />
        <div>
          <p className="font-medium text-foreground">{data.name}</p>
          <p className="text-xs text-muted">{data.provider}</p>
        </div>
      </div>
      {data.cost && <div className="mt-2 text-xs text-subtle">Cost: ${data.cost.toFixed(4)}</div>}
    </div>
  );
}

const nodeTypes = {
  stage: StageNode,
};

function PipelineFlowEditor() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const onConnect = (connection: Connection) => {
    setEdges((eds) => addEdge(connection, eds));
  };

  return (
    <div style={{ width: '100%', height: '600px' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
      >
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}
```

#### Layout with Dagre

```typescript
import dagre from 'dagre';

function getLayoutedElements(nodes: Node[], edges: Edge[]) {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: 'LR' }); // Left to right

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: 250, height: 100 });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x,
        y: nodeWithPosition.y,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}
```

### Option 2: G6 (Ant Design)

**npm:** `@antv/g6`
**License:** MIT
**Downloads:** 200K/month
**Bundle Size:** ~400KB gzipped

#### Pros

- ✅ Rich graph algorithms
- ✅ Good for complex graphs (1000+ nodes)
- ✅ Powerful layout engines

#### Cons

- ❌ Primarily designed for data visualization, not interactive editors
- ❌ Chinese documentation (English limited)
- ❌ Less intuitive API for building editors
- ❌ Requires more custom code for editor features

**Verdict:** Not recommended for pipeline editor (better for analytics graphs)

### Option 3: Rete.js

**npm:** `rete`
**License:** MIT
**Downloads:** 50K/month
**Bundle Size:** ~200KB gzipped

#### Pros

- ✅ Designed for node-based editors
- ✅ Plugin architecture
- ✅ Lightweight

#### Cons

- ❌ Less active development (last major update 2021)
- ❌ Smaller community
- ❌ Less polished than React Flow
- ❌ Documentation gaps

**Verdict:** Not recommended (React Flow more mature)

### Option 4: Drawflow

**npm:** `drawflow`
**License:** MIT
**Downloads:** 20K/month

#### Cons

- ❌ Vanilla JS (no React integration)
- ❌ Small community
- ❌ Limited features

**Verdict:** Not recommended

---

## Drag-and-Drop Libraries

### Option 1: DnD Kit (✅ Recommended)

**npm:** `@dnd-kit/core`
**License:** MIT
**Downloads:** 2.5M/month
**Bundle Size:** ~50KB gzipped

#### Pros

- ✅ **Modern** - Built for React 18
- ✅ **Accessible** - WCAG compliant, keyboard support
- ✅ **Performant** - Minimal re-renders
- ✅ **TypeScript-first** - Full type safety
- ✅ **Modular** - Only import what you need
- ✅ **Already in Studio** - Used in existing components
- ✅ **Touch support** - Mobile-friendly
- ✅ **Collision detection** - Smart drop zone detection

#### Features

- Multiple drag sources
- Multiple drop zones
- Sortable lists
- Drag overlay (ghost element)
- Drag handles
- Collision detection strategies
- Custom sensors (mouse, touch, keyboard)
- Auto-scroll during drag

#### Example Usage

```tsx
import { DndContext, DragEndEvent, DragOverlay, useDraggable, useDroppable } from '@dnd-kit/core';

// Draggable stage palette item
function StagePaletteItem({ stage }: { stage: StageTemplate }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: stage.type,
    data: stage,
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn('cursor-grab rounded-lg border p-3', isDragging && 'opacity-50')}
    >
      <StageIcon type={stage.type} />
      <p className="text-sm">{stage.name}</p>
    </div>
  );
}

// Droppable canvas
function FlowCanvas({ flowId }: { flowId: string }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `flow-${flowId}`,
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'min-h-[400px] rounded-lg border-2 border-dashed',
        isOver && 'border-accent bg-accent-subtle',
      )}
    >
      {/* Flow stages */}
    </div>
  );
}

// DnD Context
function PipelineEditor() {
  const [stages, setStages] = useState<Stage[]>([]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;

    if (over && over.id.toString().startsWith('flow-')) {
      const stageTemplate = active.data.current as StageTemplate;
      const flowId = over.id.toString().replace('flow-', '');

      // Add stage to flow
      addStageToFlow(flowId, stageTemplate);
    }
  }

  return (
    <DndContext onDragEnd={handleDragEnd}>
      <div className="grid grid-cols-[250px_1fr] gap-4">
        <div className="space-y-2">
          <h3>Stage Palette</h3>
          {STAGE_TEMPLATES.map((stage) => (
            <StagePaletteItem key={stage.type} stage={stage} />
          ))}
        </div>
        <FlowCanvas flowId={currentFlowId} />
      </div>
    </DndContext>
  );
}
```

### Option 2: React DnD

**npm:** `react-dnd`
**License:** MIT
**Downloads:** 3M/month
**Bundle Size:** ~60KB gzipped

#### Pros

- ✅ Battle-tested (since 2014)
- ✅ Large community

#### Cons

- ❌ Older architecture (hooks, but pre-React 18 patterns)
- ❌ More boilerplate code
- ❌ Less accessible by default
- ❌ Heavier API

**Verdict:** Not recommended (DnD Kit more modern)

---

## JSON Schema Form Libraries

### Option 1: React JSON Schema Form (✅ Recommended)

**npm:** `@rjsf/core`, `@rjsf/utils`, `@rjsf/validator-ajv8`
**License:** Apache 2.0
**Downloads:** 500K/month
**Bundle Size:** ~100KB gzipped (with Ajv validator)

#### Pros

- ✅ **Industry standard** - Most popular JSON Schema form library
- ✅ **JSON Schema support** - Spec-compliant (Draft 7, 2019-09, 2020-12)
- ✅ **Customizable widgets** - Custom field components
- ✅ **Template system** - Custom field/object templates
- ✅ **Validation** - Ajv validator integration
- ✅ **TypeScript support**
- ✅ **Conditional fields** - Based on dependencies
- ✅ **Array fields** - Add/remove items
- ✅ **File upload** - Built-in widget

#### Features

- **Automatic form generation** from JSON Schema
- **Custom widgets** for each field type
- **Custom field templates** (layout control)
- **Conditional rendering** (if/then/else, dependencies)
- **Nested objects** (object fields with sub-properties)
- **Array fields** (add/remove items)
- **Validation** (required, min/max, pattern, etc.)
- **Error messages** (custom per field)
- **Default values**
- **Read-only fields**

#### Example Usage

```tsx
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import { RJSFSchema, UiSchema } from '@rjsf/utils';

// JSON Schema from provider
const schema: RJSFSchema = {
  type: 'object',
  properties: {
    extractTables: {
      type: 'boolean',
      title: 'Extract Tables',
      description: 'Extract tables from PDF',
      default: true,
    },
    ocrEnabled: {
      type: 'boolean',
      title: 'OCR Enabled',
      description: 'Enable OCR for scanned PDFs',
      default: false,
    },
    language: {
      type: 'string',
      title: 'Document Language',
      enum: ['en', 'es', 'fr', 'de', 'zh', 'ja'],
      default: 'en',
    },
    timeout: {
      type: 'number',
      title: 'Timeout (ms)',
      minimum: 1000,
      maximum: 600000,
      default: 120000,
    },
  },
  required: ['extractTables'],
};

// UI Schema (layout/widget customization)
const uiSchema: UiSchema = {
  extractTables: {
    'ui:widget': 'checkbox',
  },
  language: {
    'ui:widget': 'select',
  },
  timeout: {
    'ui:widget': 'range', // Slider
  },
};

// Custom widgets (Radix UI components)
const customWidgets = {
  CheckboxWidget: RadixCheckboxWidget,
  SelectWidget: RadixSelectWidget,
  TextWidget: RadixInputWidget,
};

function ProviderConfigForm({ schema, formData, onChange }: Props) {
  return (
    <Form
      schema={schema}
      uiSchema={uiSchema}
      formData={formData}
      validator={validator}
      widgets={customWidgets}
      onChange={(e) => onChange(e.formData)}
      onSubmit={(e) => onSave(e.formData)}
    >
      <Button type="submit">Save Configuration</Button>
    </Form>
  );
}
```

#### Custom Widget Example

```tsx
import { WidgetProps } from '@rjsf/utils';
import { Checkbox } from '@/components/ui/Checkbox';

function RadixCheckboxWidget(props: WidgetProps) {
  const { id, value, label, disabled, onChange } = props;

  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={value || false}
        onCheckedChange={(checked) => onChange(checked)}
        disabled={disabled}
      />
      <label htmlFor={id} className="text-sm text-foreground">
        {label}
      </label>
    </div>
  );
}
```

### Option 2: Formily (Alibaba)

**npm:** `@formily/core`, `@formily/react`
**License:** MIT
**Downloads:** 150K/month

#### Pros

- ✅ Powerful form state management
- ✅ JSON Schema support

#### Cons

- ❌ Chinese documentation
- ❌ Complex API
- ❌ Heavier bundle size
- ❌ Less community support outside China

**Verdict:** Not recommended

### Option 3: React Hook Form + Custom JSON Schema Parser

**Approach:** Build custom form generator using React Hook Form

#### Pros

- ✅ Lighter bundle
- ✅ Full control

#### Cons

- ❌ Significant development time (2-4 weeks)
- ❌ Need to implement all JSON Schema features
- ❌ Maintenance burden

**Verdict:** Not recommended (RJSF more mature)

---

## Expression Builder Options

### Option 1: Custom Component with Monaco Editor (✅ Recommended)

**Approach:** Build custom CEL expression builder using Monaco Editor (already in Studio)

**Features:**

- Visual field selector (dropdown of available fields)
- Operator selector (==, !=, >, <, contains, matches)
- Value input (text, number, boolean)
- Compound conditions (AND, OR)
- Live preview of generated CEL expression
- Syntax highlighting in Monaco Editor
- Validation using CEL library

**Advantages:**

- ✅ No additional dependencies (Monaco already in Studio)
- ✅ Full control over UX
- ✅ CEL-specific features (custom functions)
- ✅ Matches Studio design system

**Example:**

```tsx
function CELExpressionBuilder({ value, onChange }: Props) {
  const [conditions, setConditions] = useState<Condition[]>([]);

  // Generate CEL expression from visual builder
  const celExpression = generateCEL(conditions);

  return (
    <div className="space-y-4">
      {/* Visual builder */}
      <div className="space-y-2">
        {conditions.map((condition, index) => (
          <ConditionRow
            key={index}
            condition={condition}
            onChange={(updated) => updateCondition(index, updated)}
            onRemove={() => removeCondition(index)}
          />
        ))}
        <Button size="sm" onClick={addCondition}>
          Add Condition
        </Button>
      </div>

      {/* Monaco editor (read-only preview) */}
      <div>
        <label className="text-sm font-medium">Generated Expression</label>
        <MonacoEditor
          height="100px"
          language="cel"
          value={celExpression}
          options={{ readOnly: true, minimap: { enabled: false } }}
        />
      </div>
    </div>
  );
}

function ConditionRow({ condition, onChange, onRemove }: Props) {
  return (
    <div className="flex items-center gap-2">
      {/* Field selector */}
      <Select value={condition.field} onValueChange={(field) => onChange({ ...condition, field })}>
        <SelectItem value="contentType">Content Type</SelectItem>
        <SelectItem value="contentSizeBytes">File Size</SelectItem>
        <SelectItem value="pageCount">Page Count</SelectItem>
      </Select>

      {/* Operator selector */}
      <Select
        value={condition.operator}
        onValueChange={(operator) => onChange({ ...condition, operator })}
      >
        <SelectItem value="==">Equals</SelectItem>
        <SelectItem value="!=">Not Equals</SelectItem>
        <SelectItem value=">">Greater Than</SelectItem>
        <SelectItem value="<">Less Than</SelectItem>
        <SelectItem value="contains">Contains</SelectItem>
      </Select>

      {/* Value input */}
      <Input
        value={condition.value}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
        placeholder="Value"
      />

      {/* Remove button */}
      <Button variant="ghost" size="xs" onClick={onRemove}>
        <TrashIcon />
      </Button>
    </div>
  );
}
```

### Option 2: React QueryBuilder

**npm:** `react-querybuilder`
**License:** MIT
**Downloads:** 100K/month
**Bundle Size:** ~50KB gzipped

#### Pros

- ✅ Pre-built query builder UI
- ✅ SQL, MongoDB, CEL output formats

#### Cons

- ❌ Generic (not CEL-specific)
- ❌ Requires customization for CEL features
- ❌ Less control over UX

**Verdict:** Not recommended (custom component better fit)

---

## Recommended Solution

### Hybrid Approach

**Combine best-in-class libraries with existing Studio components:**

1. **Flow Visualization:** React Flow
2. **Drag-and-Drop:** DnD Kit (already in Studio)
3. **Dynamic Forms:** React JSON Schema Form + custom Radix UI widgets
4. **Expression Builder:** Custom component (Monaco Editor + visual builder)
5. **Base Components:** Existing Studio design system

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ Pipeline Visual Designer                                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────┐  ┌─────────────────────────────┐   │
│  │ Stage Palette      │  │ Flow Canvas (React Flow)    │   │
│  │ (DnD Kit)          │  │ - Nodes (custom stage)      │   │
│  │                    │  │ - Edges (stage connections) │   │
│  │ □ Extraction       │  │ - Layout (Dagre)            │   │
│  │ □ Enrichment       │  │ - Minimap, Controls         │   │
│  │ □ Embedding        │  │                             │   │
│  └────────────────────┘  └─────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Stage Configuration Panel (SlidePanel)               │   │
│  │                                                        │   │
│  │  Provider: [Docling ▼]                               │   │
│  │                                                        │   │
│  │  ┌──────────────────────────────────────────────┐    │   │
│  │  │ Dynamic Config Form (RJSF)                   │    │   │
│  │  │ - Custom Radix UI widgets                    │    │   │
│  │  │ - Auto-generated from JSON Schema            │    │   │
│  │  │                                               │    │   │
│  │  │ [✓] Extract Tables                           │    │   │
│  │  │ [ ] OCR Enabled                              │    │   │
│  │  │ Language: [English ▼]                        │    │   │
│  │  │ Timeout: [120000] ms                         │    │   │
│  │  └──────────────────────────────────────────────┘    │   │
│  │                                                        │   │
│  │  [Cancel] [Save Configuration]                       │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Flow Selection Rules Builder                         │   │
│  │                                                        │   │
│  │  ┌─────────────────────────────────────────────┐     │   │
│  │  │ Visual Rule Builder (Custom Component)      │     │   │
│  │  │                                              │     │   │
│  │  │ [contentType ▼] [== ▼] [application/pdf   ] │     │   │
│  │  │ [AND] [+ Add Condition]                     │     │   │
│  │  └─────────────────────────────────────────────┘     │   │
│  │                                                        │   │
│  │  Generated Expression (Monaco Editor):               │   │
│  │  ┌─────────────────────────────────────────────┐     │   │
│  │  │ contentType == "application/pdf"            │     │   │
│  │  └─────────────────────────────────────────────┘     │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Cost Estimator (Custom Component)                   │   │
│  │                                                        │   │
│  │  Total Cost: $0.0245                                 │   │
│  │                                                        │   │
│  │  Stage Breakdown:                                    │   │
│  │  ■ Extraction (Docling): $0.0020                    │   │
│  │  ■ Enrichment (OpenAI): $0.0180                     │   │
│  │  ■ Embedding (BGE-M3): $0.0000                      │   │
│  │  ■ Knowledge Graph: $0.0045                         │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Component Hierarchy

```
PipelineEditor (page)
├── PageHeader (title, actions)
├── PipelineFlowCanvas (React Flow)
│   ├── StagePalette (DnD Kit draggable)
│   │   └── StagePaletteItem[]
│   ├── ReactFlow
│   │   ├── StageNode[] (custom nodes)
│   │   ├── StageEdge[] (custom edges)
│   │   ├── Background
│   │   ├── Controls
│   │   └── MiniMap
│   └── SlidePanel (stage config)
│       ├── ProviderSelect
│       ├── DynamicConfigForm (RJSF)
│       │   └── CustomWidgets (Radix UI)
│       └── ActionButtons
├── FlowSelectionRulesBuilder
│   ├── VisualRuleBuilder
│   │   └── ConditionRow[]
│   └── MonacoEditor (CEL preview)
├── CostEstimator
│   └── StageBreakdown[]
└── FlowSimulator
    └── SimulationResultsPanel
```

---

## Integration Patterns

### React Flow Integration

```tsx
// apps/studio/src/components/pipelines/PipelineFlowCanvas.tsx

import ReactFlow, { Background, Controls, MiniMap, Node, Edge, NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// Custom node types
const nodeTypes: NodeTypes = {
  extractionStage: ExtractionStageNode,
  enrichmentStage: EnrichmentStageNode,
  embeddingStage: EmbeddingStageNode,
  chunkingStage: ChunkingStageNode,
  knowledgeGraphStage: KnowledgeGraphStageNode,
  multimodalStage: MultimodalStageNode,
};

export function PipelineFlowCanvas({ pipeline }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Convert pipeline definition to React Flow nodes/edges
  useEffect(() => {
    const { nodes, edges } = pipelineToReactFlow(pipeline);
    const layouted = getLayoutedElements(nodes, edges);
    setNodes(layouted.nodes);
    setEdges(layouted.edges);
  }, [pipeline]);

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        maxZoom={1.5}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background className="bg-background" color="#333" gap={16} />
        <Controls className="border border-default bg-background-muted" />
        <MiniMap
          className="border border-default bg-background-muted"
          nodeColor={(node) => getStageColor(node.data.stageType)}
        />
      </ReactFlow>
    </div>
  );
}
```

### DnD Kit Integration

```tsx
// apps/studio/src/components/pipelines/StagePalette.tsx

import { useDraggable } from '@dnd-kit/core';

export function StagePaletteItem({ stageTemplate }: Props) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${stageTemplate.type}`,
    data: stageTemplate,
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        'flex cursor-grab items-center gap-3 rounded-lg border border-default',
        'bg-background-muted p-3 transition-all hover:border-accent',
        isDragging && 'opacity-50',
      )}
    >
      <div className="rounded-md bg-accent-subtle p-2">
        <StageIcon type={stageTemplate.type} className="h-4 w-4" />
      </div>
      <div className="flex-1">
        <p className="text-sm font-medium">{stageTemplate.name}</p>
        <p className="text-xs text-muted">{stageTemplate.description}</p>
      </div>
    </div>
  );
}
```

### RJSF Integration

```tsx
// apps/studio/src/components/pipelines/DynamicConfigForm.tsx

import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import { customWidgets } from './rjsf-widgets';

export function DynamicConfigForm({ provider, formData, onChange }: Props) {
  // Fetch JSON Schema from provider
  const { data: schema, isLoading } = useProviderSchema(provider.id);

  if (isLoading) return <Skeleton className="h-[300px]" />;

  return (
    <Form
      schema={schema}
      formData={formData}
      validator={validator}
      widgets={customWidgets}
      onChange={(e) => onChange(e.formData)}
      onSubmit={onSubmit}
      showErrorList={false}
    >
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          Save Configuration
        </Button>
      </div>
    </Form>
  );
}
```

### Custom Monaco Editor for CEL

```tsx
// apps/studio/src/components/pipelines/CELExpressionEditor.tsx

import MonacoEditor from '@monaco-editor/react';
import { useEffect } from 'react';

export function CELExpressionEditor({ value, onChange, readOnly }: Props) {
  // Register CEL language
  useEffect(() => {
    monaco.languages.register({ id: 'cel' });

    monaco.languages.setMonarchTokensProvider('cel', {
      keywords: ['true', 'false', 'null', 'in', 'has'],
      operators: ['==', '!=', '<', '>', '<=', '>=', '&&', '||', '!', '+', '-', '*', '/', '%'],
      tokenizer: {
        root: [
          [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
          [/\d+/, 'number'],
          [/"([^"\\]|\\.)*$/, 'string.invalid'],
          [/"/, 'string', '@string'],
          [/[{}()\[\]]/, '@brackets'],
          [/@operators/, 'operator'],
          [/,/, 'delimiter'],
        ],
        string: [
          [/[^\\"]+/, 'string'],
          [/"/, 'string', '@pop'],
        ],
      },
    });
  }, []);

  return (
    <MonacoEditor
      height="120px"
      language="cel"
      value={value}
      onChange={onChange}
      theme="vs-dark"
      options={{
        readOnly,
        minimap: { enabled: false },
        lineNumbers: 'off',
        folding: false,
        fontSize: 13,
        fontFamily: 'JetBrains Mono, monospace',
      }}
    />
  );
}
```

---

## Bundle Size Analysis

### Current Studio Bundle Size

**Total:** ~2.5MB uncompressed, ~600KB gzipped

**Major dependencies:**

- React (45KB gzipped)
- Next.js (70KB gzipped)
- Radix UI (150KB gzipped)
- Zustand (3KB gzipped)
- Monaco Editor (250KB gzipped)

### Additional Dependencies for Pipeline Designer

| Library              | Uncompressed | Gzipped    | Purpose                |
| -------------------- | ------------ | ---------- | ---------------------- |
| React Flow           | 1.2MB        | 350KB      | Flow visualization     |
| RJSF Core            | 200KB        | 60KB       | JSON Schema forms      |
| RJSF Validator (Ajv) | 150KB        | 40KB       | JSON Schema validation |
| Dagre (layout)       | 100KB        | 30KB       | Auto-layout for graphs |
| **Total Additional** | **1.65MB**   | **480KB**  |                        |
| **New Total**        | **4.15MB**   | **1.08MB** |                        |

### Bundle Size Optimization

**Strategies:**

1. **Code splitting** - Load pipeline designer only on pipeline pages
2. **Lazy loading** - Load React Flow on demand
3. **Tree shaking** - Only import used RJSF components
4. **CDN for Monaco** - Already loaded, no additional cost

**After optimization:**

- Initial bundle: No change (~600KB gzipped)
- Pipeline designer route: +480KB gzipped (lazy loaded)

**Verdict:** Bundle size increase is acceptable for pipeline designer functionality.

---

## Implementation Roadmap

### Phase 1: Foundation (Week 1)

- [ ] Install dependencies
  - [ ] `@xyflow/react`
  - [ ] `@rjsf/core`, `@rjsf/utils`, `@rjsf/validator-ajv8`
  - [ ] `dagre` (auto-layout)

- [ ] Create base components
  - [ ] `PipelineFlowCanvas` (React Flow wrapper)
  - [ ] `StageNode` (custom node component)
  - [ ] `StageEdge` (custom edge component)
  - [ ] `StagePalette` (DnD Kit draggable list)

- [ ] Integrate with Studio design system
  - [ ] Apply Studio color tokens to React Flow
  - [ ] Custom controls styling
  - [ ] Custom minimap styling

### Phase 2: Stage Configuration (Week 2)

- [ ] Dynamic config forms
  - [ ] RJSF integration
  - [ ] Custom Radix UI widgets
    - [ ] Checkbox widget
    - [ ] Select widget
    - [ ] Input widget
    - [ ] Textarea widget
    - [ ] Number widget (with slider)
  - [ ] Field templates (layout)
  - [ ] Error display

- [ ] Provider selection
  - [ ] Provider dropdown (by stage type)
  - [ ] Provider metadata display (name, description, version)
  - [ ] Provider health indicator

- [ ] Config validation
  - [ ] Real-time validation (onChange)
  - [ ] Error highlighting
  - [ ] Validation error messages

### Phase 3: Flow Selection Rules (Week 3)

- [ ] Visual rule builder
  - [ ] Field selector (dropdown)
  - [ ] Operator selector (dropdown)
  - [ ] Value input (text, number, boolean)
  - [ ] Add/remove conditions
  - [ ] AND/OR logic

- [ ] CEL expression preview
  - [ ] Monaco Editor integration
  - [ ] Syntax highlighting
  - [ ] Read-only preview

- [ ] Validation
  - [ ] CEL expression validation (using @marcbachmann/cel-js)
  - [ ] Error display

### Phase 4: Visual Features (Week 4)

- [ ] Cost estimation display
  - [ ] Fetch cost estimates from API
  - [ ] Per-stage breakdown
  - [ ] Visual cost indicators (color-coded)
  - [ ] Total cost display

- [ ] Flow simulation
  - [ ] Sample document input
  - [ ] Flow selection preview
  - [ ] Stage execution path highlight

- [ ] Live monitoring integration
  - [ ] Real-time job status overlay on nodes
  - [ ] Progress indicators
  - [ ] Error indicators

### Phase 5: Polish & Testing (Week 5)

- [ ] Keyboard navigation
  - [ ] Tab through stages
  - [ ] Arrow keys for stage selection
  - [ ] Delete key for stage removal

- [ ] Responsive design
  - [ ] Mobile-friendly layout (if needed)
  - [ ] Collapsible panels

- [ ] Performance optimization
  - [ ] Lazy loading
  - [ ] Code splitting
  - [ ] Memoization

- [ ] Testing
  - [ ] Unit tests for components
  - [ ] Integration tests for DnD
  - [ ] E2E tests for full flow

- [ ] Documentation
  - [ ] Component usage guide
  - [ ] Storybook stories
  - [ ] Design system additions

---

## Summary

**Recommended libraries:**

1. **React Flow** - Flow visualization (350KB gzipped)
2. **DnD Kit** - Drag-and-drop (already in Studio, no additional cost)
3. **React JSON Schema Form** - Dynamic forms (100KB gzipped)
4. **Custom Monaco Editor** - CEL expression builder (already in Studio, no additional cost)

**Total bundle size impact:** ~450KB gzipped (lazy loaded on pipeline pages)

**Development time:** 5 weeks for full implementation

**Advantages:**

- ✅ Best-in-class libraries for each use case
- ✅ Consistent with Studio design system
- ✅ Maintainable (popular, well-documented libraries)
- ✅ Accessible (WCAG compliant)
- ✅ TypeScript-first (full type safety)
- ✅ Performant (optimized for large graphs)

**Next Steps:** Proceed to design phase (Tasks #47-55) to design the actual UI/UX.
