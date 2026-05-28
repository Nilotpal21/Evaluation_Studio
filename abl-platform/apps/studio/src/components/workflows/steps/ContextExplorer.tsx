/**
 * ContextExplorer Component
 *
 * Floating panel/popover showing available {{expression}} paths that can be
 * inserted into step configuration inputs. Displays a searchable tree view
 * with three top-level categories: trigger, steps, and context.
 */

'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { clsx } from 'clsx';
import {
  Search,
  ChevronRight,
  ChevronDown,
  Play,
  Layers,
  Braces,
  Hash,
  Type,
  ToggleLeft,
  List,
  Copy,
  Brain,
  Bot,
  Zap,
  Info,
  Webhook,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TriggerOption } from '../canvas/hooks/useWorkflowExpressionContext';
import { useNodeExpressionContext } from '../canvas/config/NodeExpressionContext';
import { ConnectorLogo } from '../../connections/ConnectorLogo';
import { useConnections } from '../../../hooks/useConnections';
import { useNavigationStore } from '../../../store/navigation-store';
import { useWorkflowCanvasStore } from '../../../store/workflow-canvas-store';

// =============================================================================
// TYPES
// =============================================================================

interface PreviousStep {
  id: string;
  name: string;
  outputSchema?: Record<string, unknown>;
  /** Canvas node id — used to open the Test Action modal for this step. */
  canvasNodeId?: string;
  /** Integration node has no sampleOutput yet — show a "Test action" row. */
  needsTestAction?: boolean;
  /** Connector short name (e.g. "gmail") — drives the connector logo on the step row. */
  connectorName?: string;
}

interface ContextExplorerProps {
  triggers: TriggerOption[];
  previousSteps: PreviousStep[];
  executionContext?: Record<string, unknown> | null;
  onSelect: (expression: string) => void;
  /** Optional className override for embedding in panels instead of floating. */
  className?: string;
  style?: React.CSSProperties;
}

interface TreeNode {
  key: string;
  label: string;
  expression: string;
  icon: LucideIcon;
  children?: TreeNode[];
  isLeaf: boolean;
  type?: string;
  /**
   * If set, this node renders as an inline action button instead of an
   * expression row (e.g. a "Test action" row for integration nodes that
   * have no sampleOutput yet). The button calls onAction() when clicked.
   */
  actionLabel?: string;
  onAction?: () => void;
  /**
   * For integration step rows — connector short name used to render the
   * connector logo instead of the generic icon. Takes precedence over `icon`.
   */
  connectorName?: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const AGENT_SESSION_FIELDS: TreeNode[] = [
  {
    key: 'agentName',
    label: 'Agent Name',
    expression: '{{agentSession.agentName}}',
    icon: Type,
    isLeaf: true,
    type: 'string',
  },
  {
    key: 'channel',
    label: 'Channel',
    expression: '{{agentSession.channel}}',
    icon: Type,
    isLeaf: true,
    type: 'string',
  },
  {
    key: 'endUserId',
    label: 'End User ID',
    expression: '{{agentSession.endUserId}}',
    icon: Hash,
    isLeaf: true,
    type: 'string',
  },
];

const AGENT_CONTEXT_FIELDS: TreeNode[] = [
  {
    key: 'caller',
    label: 'caller',
    expression: '{{agentContext.caller}}',
    icon: Braces,
    isLeaf: false,
    type: 'object',
    children: [
      {
        key: 'caller.id',
        label: 'id',
        expression: '{{agentContext.caller.id}}',
        icon: Hash,
        isLeaf: true,
        type: 'string',
      },
    ],
  },
  {
    key: 'invocation',
    label: 'invocation',
    expression: '{{agentContext.invocation}}',
    icon: Braces,
    isLeaf: false,
    type: 'object',
    children: [
      {
        key: 'invocation.tool',
        label: 'tool',
        expression: '{{agentContext.invocation.tool}}',
        icon: Type,
        isLeaf: true,
        type: 'string',
      },
      {
        key: 'invocation.args',
        label: 'args',
        expression: '{{agentContext.invocation.args}}',
        icon: Braces,
        isLeaf: true,
        type: 'object',
      },
    ],
  },
  {
    key: 'attachments',
    label: 'attachments',
    expression: '{{agentContext.attachments}}',
    icon: List,
    isLeaf: false,
    type: 'array',
    children: [
      {
        key: 'attachments.name',
        label: 'name',
        expression: '{{agentContext.attachments[0].name}}',
        icon: Type,
        isLeaf: true,
        type: 'string',
      },
      {
        key: 'attachments.mimeType',
        label: 'mimeType',
        expression: '{{agentContext.attachments[0].mimeType}}',
        icon: Type,
        isLeaf: true,
        type: 'string',
      },
      {
        key: 'attachments.sizeBytes',
        label: 'sizeBytes',
        expression: '{{agentContext.attachments[0].sizeBytes}}',
        icon: Hash,
        isLeaf: true,
        type: 'number',
      },
    ],
  },
];

const MEMORY_FIELDS: TreeNode[] = [
  {
    key: 'memory.workflow',
    label: 'workflow',
    expression: '{{memory.workflow}}',
    icon: Braces,
    isLeaf: true,
    type: 'object',
  },
  {
    key: 'memory.project',
    label: 'project',
    expression: '{{memory.project}}',
    icon: Braces,
    isLeaf: true,
    type: 'object',
  },
  {
    key: 'memory.user',
    label: 'user',
    expression: '{{memory.user}}',
    icon: Braces,
    isLeaf: true,
    type: 'object',
  },
];

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Determine the appropriate icon for a JSON schema type.
 */
function iconForType(value: unknown): LucideIcon {
  if (value === null || value === undefined) return Type;
  if (typeof value === 'number') return Hash;
  if (typeof value === 'boolean') return ToggleLeft;
  if (typeof value === 'string') return Type;
  if (Array.isArray(value)) return List;
  if (typeof value === 'object') return Braces;
  return Type;
}

/**
 * Get display type name for a value.
 */
function typeNameForValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Build tree nodes from a nested object structure.
 */
/**
 * Build tree nodes from a nested object.
 *
 * `excludeTopLevel` filters at the immediate level only — used for shapes where
 * certain keys exist as siblings of business data (e.g. step-level telemetry
 * `durationMs` next to `output`).
 *
 * `excludeAtAnyDepth` filters at every level — used for engine internals that
 * may ride along inside `output.*` regardless of where (e.g. agent's
 * `traceEvents`, `responseMetadata`). These are well-known internal field
 * names, NOT generic terms users might pick.
 */
function buildNodesFromObject(
  obj: Record<string, unknown>,
  pathPrefix: string,
  excludeTopLevel?: ReadonlySet<string>,
  excludeAtAnyDepth?: ReadonlySet<string>,
): TreeNode[] {
  return Object.entries(obj)
    .filter(([key]) => !excludeTopLevel?.has(key) && !excludeAtAnyDepth?.has(key))
    .map(([key, value]) => {
      const expression = `{{${pathPrefix}.${key}}}`;
      const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);

      if (isObject) {
        return {
          key,
          label: key,
          expression,
          icon: Braces,
          isLeaf: false,
          type: 'object',
          // Top-level set is intentionally NOT passed to recursive calls —
          // those keys only mean "telemetry" at the depth they were declared.
          // Deep set IS passed through so internals stay hidden at any depth.
          children: buildNodesFromObject(
            value as Record<string, unknown>,
            `${pathPrefix}.${key}`,
            undefined,
            excludeAtAnyDepth,
          ),
        };
      }

      return {
        key,
        label: key,
        expression,
        icon: iconForType(value),
        isLeaf: true,
        type: typeNameForValue(value),
      };
    });
}

/**
 * Telemetry / internal fields hidden from the Expression Browser. Engine still
 * resolves them at runtime — we just don't surface them to authors. Keep the
 * runtime-derived tree in sync with the static fallbacks defined above.
 */
const HIDDEN_AGENT_SESSION_KEYS: ReadonlySet<string> = new Set([
  'sessionId',
  'source',
  'startedAt',
  'lastActivityAt',
  'locale',
]);
const HIDDEN_AGENT_CONTEXT_KEYS: ReadonlySet<string> = new Set(['messageMetadata']);
/**
 * Hidden at any depth inside agentContext. `type` is the discriminator on
 * `agentContext.caller` (e.g. 'agent', 'system') — kept hidden in static
 * mode, must also be hidden when the runtime walker recurses into caller.
 * Scoped narrowly to the agentContext walk so unrelated `type` fields in
 * other namespaces are unaffected.
 */
const HIDDEN_AGENT_CONTEXT_DEEP_KEYS: ReadonlySet<string> = new Set(['type']);

/**
 * Step-level telemetry hidden ONLY at the immediate child level of
 * `steps.X.<here>`. These names (input, startedAt, etc.) are too common to
 * filter recursively — a user's API response or agent output might
 * legitimately contain a field called `input` or `startedAt`, and we don't
 * want to hide it.
 */
const HIDDEN_STEP_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'input',
  'durationMs',
  'startedAt',
  'completedAt',
  'nodeType',
  'stepId',
  'metrics',
  'consoleLogs',
  'mappingErrors',
  'controlFlow',
]);

/**
 * Engine-internal output fields hidden at ANY depth under a step. These names
 * are specific to engine machinery (agent traces, human-task timestamps) —
 * users wouldn't compose them into expressions even if they appear deep
 * inside an output payload.
 */
const HIDDEN_STEP_OUTPUT_INTERNAL_KEYS: ReadonlySet<string> = new Set([
  'traceEvents',
  'responseMetadata',
  'respondedAt',
]);

const HIDDEN_TRIGGER_KEYS: ReadonlySet<string> = new Set(['metadata']);

function prefixNodeKeys(nodes: TreeNode[], prefix: string): TreeNode[] {
  return nodes.map((n) => ({
    ...n,
    key: `${prefix}${n.key}`,
    children: n.children ? prefixNodeKeys(n.children, `${prefix}${n.key}.`) : undefined,
  }));
}

/**
 * Build tree nodes from a JSON schema-like outputSchema.
 */
function buildNodesFromSchema(schema: Record<string, unknown>, pathPrefix: string): TreeNode[] {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) {
    // Treat the schema itself as a flat object of field names
    return Object.entries(schema).map(([key, value]) => {
      const expression = `{{${pathPrefix}.${key}}}`;
      const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);

      if (isObject) {
        return {
          key,
          label: key,
          expression,
          icon: Braces,
          isLeaf: false,
          type: 'object',
          children: buildNodesFromSchema(value as Record<string, unknown>, `${pathPrefix}.${key}`),
        };
      }

      return {
        key,
        label: key,
        expression,
        icon: iconForType(value),
        isLeaf: true,
        type: typeof value === 'string' ? value : typeNameForValue(value),
      };
    });
  }

  return Object.entries(properties).map(([key, propSchema]) => {
    const expression = `{{${pathPrefix}.${key}}}`;
    const propType = propSchema.type as string | undefined;

    if (propType === 'object' && propSchema.properties) {
      return {
        key,
        label: key,
        expression,
        icon: Braces,
        isLeaf: false,
        type: 'object',
        children: buildNodesFromSchema(
          propSchema as Record<string, unknown>,
          `${pathPrefix}.${key}`,
        ),
      };
    }

    return {
      key,
      label: key,
      expression,
      icon:
        propType === 'number' || propType === 'integer'
          ? Hash
          : propType === 'boolean'
            ? ToggleLeft
            : propType === 'array'
              ? List
              : Type,
      isLeaf: true,
      type: propType ?? 'string',
    };
  });
}

export function buildStepOutputChildren(
  step: PreviousStep,
  outputPath: string,
  executionContext: Record<string, unknown> | null | undefined,
): TreeNode[] {
  const execStep =
    executionContext &&
    typeof executionContext === 'object' &&
    'steps' in executionContext &&
    (executionContext as Record<string, unknown>).steps &&
    typeof (executionContext as Record<string, unknown>).steps === 'object'
      ? ((executionContext as Record<string, unknown>).steps as Record<string, unknown>)[step.id]
      : undefined;
  const liveOutput =
    execStep &&
    typeof execStep === 'object' &&
    'output' in (execStep as Record<string, unknown>) &&
    (execStep as Record<string, unknown>).output &&
    typeof (execStep as Record<string, unknown>).output === 'object' &&
    !Array.isArray((execStep as Record<string, unknown>).output)
      ? ((execStep as Record<string, unknown>).output as Record<string, unknown>)
      : null;

  if (liveOutput) {
    return buildNodesFromObject(
      liveOutput,
      outputPath,
      undefined,
      HIDDEN_STEP_OUTPUT_INTERNAL_KEYS,
    );
  }
  if (step.outputSchema) {
    return buildNodesFromSchema(step.outputSchema, outputPath);
  }
  return [
    {
      key: `${step.id}.output`,
      label: 'output',
      expression: `{{${outputPath}}}`,
      icon: Braces as LucideIcon,
      isLeaf: true,
      type: 'any',
    },
  ];
}

/**
 * Recursively filter tree nodes by a search query.
 */
function filterNodes(nodes: TreeNode[], query: string): TreeNode[] {
  const lower = query.toLowerCase();
  const results: TreeNode[] = [];

  for (const node of nodes) {
    const labelMatch = node.label.toLowerCase().includes(lower);
    const exprMatch = node.expression.toLowerCase().includes(lower);

    if (node.children) {
      const filteredChildren = filterNodes(node.children, query);
      if (labelMatch || exprMatch || filteredChildren.length > 0) {
        results.push({
          ...node,
          children: filteredChildren.length > 0 ? filteredChildren : node.children,
        });
      }
    } else if (labelMatch || exprMatch) {
      results.push(node);
    }
  }

  return results;
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

interface TreeNodeItemProps {
  node: TreeNode;
  depth: number;
  onSelect: (expression: string) => void;
  expandedKeys: Set<string>;
  onToggle: (key: string) => void;
}

function TreeNodeItem({ node, depth, onSelect, expandedKeys, onToggle }: TreeNodeItemProps) {
  const isExpanded = expandedKeys.has(node.expression);
  const hasChildren = node.children && node.children.length > 0;
  const paddingLeft = depth * 16 + 8;

  const handleClick = useCallback(() => {
    if (hasChildren) {
      onToggle(node.expression);
    } else {
      onSelect(node.expression);
    }
  }, [hasChildren, node.expression, onToggle, onSelect]);

  // Action rows (e.g. "Test action") render as an inline button instead of a
  // regular expression row — no expression to insert, just side-effect on click.
  if (node.actionLabel && node.onAction) {
    return (
      <div className="relative" style={{ paddingLeft }}>
        <button
          type="button"
          onClick={node.onAction}
          className="flex items-center gap-1.5 py-1.5 text-xs text-accent hover:text-accent/80 transition-colors"
          data-testid={`context-explorer-action-${node.key}`}
        >
          <Play className="w-3 h-3" />
          {node.actionLabel}
        </button>
      </div>
    );
  }

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelect(node.expression);
    },
    [node.expression, onSelect],
  );

  const IconComponent = node.icon;

  return (
    <>
      <div className="relative group">
        <button
          onClick={handleClick}
          style={{ paddingLeft }}
          data-testid={node.isLeaf ? `context-explorer-leaf-${node.key}` : undefined}
          className={clsx(
            'w-full flex items-center gap-2 py-1.5 text-left rounded-md cursor-pointer',
            'hover:bg-background-muted transition-fast',
            node.isLeaf ? 'pr-6' : 'pr-2',
          )}
        >
          {/* Expand/collapse chevron or spacer */}
          {hasChildren ? (
            <span className="w-4 h-4 flex items-center justify-center shrink-0 text-subtle">
              {isExpanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
            </span>
          ) : (
            <span className="w-4 h-4 shrink-0" />
          )}

          {/* Icon — ConnectorLogo for integration step rows, generic Lucide otherwise */}
          {node.connectorName ? (
            <ConnectorLogo name={node.connectorName} className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <IconComponent className="w-3.5 h-3.5 text-muted shrink-0" />
          )}

          {/* Label */}
          <span className="text-xs text-foreground truncate flex-1">{node.label}</span>

          {/* Type badge */}
          {node.type && (
            <span className="text-xs text-subtle px-1 py-0.5 rounded bg-background-muted shrink-0 font-mono">
              {node.type}
            </span>
          )}
        </button>

        {/* Copy button — sibling of the main button to avoid nested <button> */}
        {node.isLeaf && (
          <button
            type="button"
            onClick={handleCopy}
            className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-0.5 text-subtle hover:text-accent transition-fast"
            aria-label={`Insert ${node.expression}`}
          >
            <Copy className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <div>
          {node.children!.map((child) => (
            <TreeNodeItem
              key={child.expression}
              node={child}
              depth={depth + 1}
              onSelect={onSelect}
              expandedKeys={expandedKeys}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </>
  );
}

interface CategorySectionProps {
  label: string;
  icon: LucideIcon;
  nodes: TreeNode[];
  onSelect: (expression: string) => void;
  expandedKeys: Set<string>;
  onToggle: (key: string) => void;
  defaultExpanded?: boolean;
  categoryKey: string;
  infoTooltip?: string;
}

function CategorySection({
  label,
  icon: CategoryIcon,
  nodes,
  onSelect,
  expandedKeys,
  onToggle,
  categoryKey,
  infoTooltip,
}: CategorySectionProps) {
  const isExpanded = expandedKeys.has(categoryKey);

  return (
    <div>
      <button
        onClick={() => onToggle(categoryKey)}
        data-testid={`context-explorer-category-${categoryKey}`}
        className={clsx(
          'w-full flex items-center gap-2 px-2 py-2 text-left',
          'hover:bg-background-muted rounded-md transition-fast',
        )}
      >
        <span className="w-4 h-4 flex items-center justify-center text-subtle">
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </span>
        <CategoryIcon className="w-3.5 h-3.5 text-accent" />
        <span className="text-xs font-semibold text-foreground uppercase tracking-wide">
          {label}
        </span>
        <span className="flex items-center gap-1 ml-auto">
          {infoTooltip && (
            <span
              title={infoTooltip}
              onClick={(e) => e.stopPropagation()}
              className="text-subtle hover:text-foreground-muted transition-fast cursor-default"
            >
              <Info className="w-3 h-3" />
            </span>
          )}
          <span className="text-xs text-subtle">{nodes.length}</span>
        </span>
      </button>

      {isExpanded && nodes.length > 0 && (
        <div className="ml-2">
          {nodes.map((node) => (
            <TreeNodeItem
              key={node.expression}
              node={node}
              depth={1}
              onSelect={onSelect}
              expandedKeys={expandedKeys}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}

      {isExpanded && nodes.length === 0 && (
        <p className="text-xs text-subtle pl-10 py-2">No fields available</p>
      )}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function ContextExplorer({
  triggers,
  previousSteps,
  executionContext,
  onSelect,
  className,
  style,
}: ContextExplorerProps) {
  const { onTestTrigger } = useNodeExpressionContext();
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(
    () => new Set<string>(['__category_steps']),
  );
  const [testingTrigger, setTestingTrigger] = useState<string | null>(null);

  // Resolve connection ids → display names so each trigger row can show the
  // bound connection / auth-profile next to its trigger name. After ABLP-913
  // the id may point at an AuthProfile rather than a Connection; the same
  // lookup table covers both since the unified picker writes whichever id.
  const projectId = useNavigationStore((s) => s.projectId);
  const openTestActionModal = useWorkflowCanvasStore((s) => s.openTestActionModal);
  const { connections } = useConnections(projectId ?? null);
  const connectionNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of connections) map.set(c.id, c.displayName);
    return map;
  }, [connections]);

  const handleTestTrigger = useCallback(
    async (triggerId: string) => {
      if (!onTestTrigger) return;
      setTestingTrigger(triggerId);
      try {
        await onTestTrigger(triggerId);
      } finally {
        setTestingTrigger(null);
      }
    },
    [onTestTrigger],
  );
  // Build nodes per trigger — used for both single and multi-trigger accordion
  const triggerGroups = useMemo(
    () =>
      (triggers ?? []).map((t) => ({
        trigger: t,
        nodes:
          t.payload && Object.keys(t.payload).length > 0
            ? buildNodesFromObject(t.payload, 'context.trigger.payload')
            : [],
      })),
    [triggers],
  );

  // Nodes from the primary trigger payload — used as static fallback when no live execution data.
  const triggerNodes = triggerGroups[0]?.nodes ?? [];

  const startStepNode = useMemo((): TreeNode => {
    // If we have live executionContext, prefer the real trigger payload shape.
    const execPayload =
      executionContext &&
      typeof executionContext === 'object' &&
      'trigger' in executionContext &&
      executionContext.trigger &&
      typeof executionContext.trigger === 'object' &&
      'payload' in (executionContext.trigger as Record<string, unknown>) &&
      (executionContext.trigger as Record<string, unknown>).payload &&
      typeof (executionContext.trigger as Record<string, unknown>).payload === 'object' &&
      !Array.isArray((executionContext.trigger as Record<string, unknown>).payload)
        ? ((executionContext.trigger as Record<string, unknown>).payload as Record<string, unknown>)
        : null;

    const inputChildrenRaw = execPayload
      ? buildNodesFromObject(execPayload, 'context.trigger.payload')
      : triggerNodes;
    const inputChildren = prefixNodeKeys(inputChildrenRaw, '__start_input.');

    const hasInputs = inputChildren.length > 0;
    const inputNode: TreeNode = {
      key: '__start_input',
      label: 'input',
      // Start node "inputs" are represented at runtime as trigger.payload.
      expression: '{{context.trigger.payload}}',
      icon: Braces,
      isLeaf: !hasInputs,
      type: 'object',
      children: hasInputs ? inputChildren : undefined,
    };

    return {
      // Avoid collisions with a user-defined step named "Start".
      key: '__start',
      label: 'Start',
      expression: '{{context.trigger.payload}}',
      icon: Layers,
      isLeaf: !hasInputs,
      type: 'step',
      children: hasInputs ? [inputNode] : undefined,
    };
  }, [executionContext, triggerNodes]);

  const stepNodes = useMemo(
    () =>
      previousSteps.map((step): TreeNode => {
        const stepPath = `context.steps.${step.id}`;
        const outputPath = `${stepPath}.output`;

        const outputChildren: TreeNode[] = buildStepOutputChildren(
          step,
          outputPath,
          executionContext,
        );

        // Inject a "Test action" row at the top of the integration step's
        // output children when no sampleOutput exists yet. The output schema
        // for integration nodes is now flat (raw provider response) — no
        // nested `data` wrapper — so the action row sits directly under
        // `output`.
        if (step.needsTestAction && step.canvasNodeId) {
          const targetNodeId = step.canvasNodeId;
          const actionRow: TreeNode = {
            key: `${step.id}.output.__test_action`,
            label: 'Test action',
            expression: '',
            icon: Braces,
            isLeaf: true,
            actionLabel: 'Test the node to load fields',
            onAction: () => openTestActionModal(targetNodeId),
          };
          outputChildren.unshift(actionRow);
        }

        const children: TreeNode[] = [
          {
            key: `${step.id}.output`,
            label: 'output',
            expression: `{{${outputPath}}}`,
            icon: Braces,
            isLeaf: outputChildren.length === 0,
            type: 'object',
            children: outputChildren.length > 0 ? outputChildren : undefined,
          },
          {
            key: `${step.id}.status`,
            label: 'status',
            expression: `{{${stepPath}.status}}`,
            icon: Type,
            isLeaf: true,
            type: 'string',
          },
          {
            key: `${step.id}.error`,
            label: 'error',
            expression: `{{${stepPath}.error}}`,
            icon: Braces,
            isLeaf: false,
            type: 'object',
            children: [
              {
                key: `${step.id}.error.code`,
                label: 'code',
                expression: `{{${stepPath}.error.code}}`,
                icon: Type,
                isLeaf: true,
                type: 'string',
              },
              {
                key: `${step.id}.error.message`,
                label: 'message',
                expression: `{{${stepPath}.error.message}}`,
                icon: Type,
                isLeaf: true,
                type: 'string',
              },
            ],
          },
        ];

        return {
          key: step.id,
          label: step.name || step.id,
          expression: `{{${stepPath}}}`,
          icon: Layers,
          // Integration steps render with the connector logo instead of the
          // generic Layers icon — mirrors how trigger rows render and how the
          // canvas node tile already renders.
          connectorName: step.connectorName,
          isLeaf: false,
          type: 'step',
          children,
        };
      }),
    [previousSteps, executionContext],
  );

  // Always show Agent Session / Agent Context sections — any workflow can be
  // invoked as a tool from an agent, and authors need to be able to reference
  // agentSession.* / agentContext.* fields at design time. When a prior run
  // exists and was agent-triggered, real values are shown; otherwise static
  // field definitions are used as a guide.
  const isAgentWorkflow = true;

  // Filter per trigger group
  const filteredTriggerGroups = useMemo(
    () =>
      triggerGroups.map(({ trigger, nodes }) => ({
        trigger,
        nodes: searchQuery ? filterNodes(nodes, searchQuery) : nodes,
      })),
    [triggerGroups, searchQuery],
  );

  const totalTriggerFieldCount = filteredTriggerGroups.reduce((s, g) => s + g.nodes.length, 0);

  const filteredSteps = useMemo(
    () => (searchQuery ? filterNodes(stepNodes, searchQuery) : stepNodes),
    [stepNodes, searchQuery],
  );

  const filteredMemory = useMemo(
    () => (searchQuery ? filterNodes(MEMORY_FIELDS, searchQuery) : MEMORY_FIELDS),
    [searchQuery],
  );

  const agentSessionNodes = useMemo((): TreeNode[] => {
    const raw =
      executionContext && 'agentSession' in executionContext
        ? (executionContext.agentSession as Record<string, unknown>)
        : null;
    if (raw && typeof raw === 'object') {
      return buildNodesFromObject(raw, 'agentSession', HIDDEN_AGENT_SESSION_KEYS);
    }
    return AGENT_SESSION_FIELDS;
  }, [executionContext]);

  const agentContextNodes = useMemo((): TreeNode[] => {
    const raw =
      executionContext && 'agentContext' in executionContext
        ? (executionContext.agentContext as Record<string, unknown>)
        : null;
    if (raw && typeof raw === 'object') {
      return buildNodesFromObject(
        raw,
        'agentContext',
        HIDDEN_AGENT_CONTEXT_KEYS,
        HIDDEN_AGENT_CONTEXT_DEEP_KEYS,
      );
    }
    return AGENT_CONTEXT_FIELDS;
  }, [executionContext]);

  const filteredAgentSession = useMemo(
    () => (searchQuery ? filterNodes(agentSessionNodes, searchQuery) : agentSessionNodes),
    [agentSessionNodes, searchQuery],
  );

  const filteredAgentContext = useMemo(
    () => (searchQuery ? filterNodes(agentContextNodes, searchQuery) : agentContextNodes),
    [agentContextNodes, searchQuery],
  );

  // Auto-expand sections that have matches when a search is active.
  useEffect(() => {
    if (!searchQuery) return;
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (filteredMemory.length > 0) next.add('__category_memory');
      if (filteredAgentSession.length > 0) next.add('__category_agent_session');
      if (filteredAgentContext.length > 0) next.add('__category_agent_context');
      return next;
    });
  }, [
    searchQuery,
    filteredMemory.length,
    filteredAgentSession.length,
    filteredAgentContext.length,
  ]);

  const handleToggle = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const totalCount =
    totalTriggerFieldCount +
    filteredSteps.length +
    filteredAgentSession.length +
    filteredAgentContext.length +
    filteredMemory.length;

  return (
    <div
      data-testid="context-explorer"
      style={style}
      className={clsx(
        'bg-background-elevated flex flex-col overflow-hidden',
        !className &&
          'w-72 border border-default rounded-xl shadow-xl max-h-[480px] animate-fade-in-scale',
        className,
      )}
    >
      {/* Header */}
      <div className="px-3 pt-3 pb-2 border-b border-default">
        <p className="text-xs font-semibold text-foreground mb-2">Expression Browser</p>
        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-subtle" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className={clsx(
              'w-full rounded-md border border-default bg-background-subtle',
              'text-xs text-foreground placeholder:text-subtle',
              'py-1.5 pl-8 pr-3',
              'focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
              'transition-default',
            )}
            placeholder="Search expressions..."
            data-testid="context-explorer-search"
          />
        </div>
      </div>

      {/* Tree content */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {totalCount === 0 && searchQuery && (
          <div className="text-center py-6">
            <p className="text-xs text-subtle">No matching expressions found</p>
          </div>
        )}

        {/* Trigger section — accordion per trigger when multiple exist */}
        <div>
          <button
            onClick={() => handleToggle('__category_trigger')}
            data-testid="context-explorer-category-__category_trigger"
            className={clsx(
              'w-full flex items-center gap-2 px-2 py-2 text-left',
              'hover:bg-background-muted rounded-md transition-fast',
            )}
          >
            <span className="w-4 h-4 flex items-center justify-center text-subtle">
              {expandedKeys.has('__category_trigger') ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
            </span>
            <Webhook className="w-3.5 h-3.5 text-accent" />
            <span className="text-xs font-semibold text-foreground uppercase tracking-wide">
              Trigger
            </span>
            <span className="text-xs text-subtle ml-auto">{totalTriggerFieldCount}</span>
          </button>

          {expandedKeys.has('__category_trigger') && (
            <div className="ml-2">
              {filteredTriggerGroups.length === 0 && (
                <p className="text-xs text-subtle pl-10 py-2">No triggers registered</p>
              )}

              {/* Single trigger — show fields directly without a nested header */}
              {filteredTriggerGroups.length === 1 &&
                (filteredTriggerGroups[0].nodes.length > 0 ? (
                  filteredTriggerGroups[0].nodes.map((node) => (
                    <TreeNodeItem
                      key={node.expression}
                      node={node}
                      depth={1}
                      onSelect={onSelect}
                      expandedKeys={expandedKeys}
                      onToggle={handleToggle}
                    />
                  ))
                ) : (
                  <div className="pl-10 py-2">
                    {onTestTrigger ? (
                      <button
                        type="button"
                        disabled={testingTrigger === filteredTriggerGroups[0].trigger.id}
                        onClick={() => void handleTestTrigger(filteredTriggerGroups[0].trigger.id)}
                        className="flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 disabled:opacity-50 transition-colors"
                      >
                        <Play className="w-3 h-3" />
                        {testingTrigger === filteredTriggerGroups[0].trigger.id
                          ? 'Testing…'
                          : 'Test to load fields'}
                      </button>
                    ) : (
                      <p className="text-xs text-subtle">No fields available</p>
                    )}
                  </div>
                ))}

              {/* Multiple triggers — one collapsible row per trigger */}
              {filteredTriggerGroups.length > 1 &&
                filteredTriggerGroups.map(({ trigger, nodes }) => {
                  const accordionKey = `__trigger_${trigger.id}`;
                  const isOpen = expandedKeys.has(accordionKey);
                  return (
                    <div key={trigger.id} data-testid={`context-explorer-trigger-${trigger.id}`}>
                      <button
                        onClick={() => handleToggle(accordionKey)}
                        className={clsx(
                          'w-full flex items-center gap-2 px-2 py-1.5 text-left rounded-md',
                          'hover:bg-background-muted transition-fast',
                        )}
                      >
                        <span className="w-4 h-4 flex items-center justify-center text-subtle shrink-0">
                          {isOpen ? (
                            <ChevronDown className="w-3 h-3" />
                          ) : (
                            <ChevronRight className="w-3 h-3" />
                          )}
                        </span>
                        {trigger.connectorName ? (
                          <ConnectorLogo
                            name={trigger.connectorName}
                            className="w-4 h-4 shrink-0"
                          />
                        ) : (
                          <Webhook className="w-3.5 h-3.5 text-muted shrink-0" />
                        )}
                        <span className="text-xs text-foreground truncate flex-1">
                          {trigger.label}
                          {trigger.connectionId && connectionNameById.get(trigger.connectionId) && (
                            <span className="text-subtle">
                              {' / '}
                              {connectionNameById.get(trigger.connectionId)}
                            </span>
                          )}
                        </span>
                        <span className="text-xs text-subtle shrink-0">{nodes.length}</span>
                      </button>

                      {isOpen && (
                        <div className="ml-4">
                          {nodes.length > 0 ? (
                            nodes.map((node) => (
                              <TreeNodeItem
                                key={node.expression}
                                node={node}
                                depth={2}
                                onSelect={onSelect}
                                expandedKeys={expandedKeys}
                                onToggle={handleToggle}
                              />
                            ))
                          ) : (
                            <div className="pl-6 py-1.5">
                              {onTestTrigger ? (
                                <button
                                  type="button"
                                  disabled={testingTrigger === trigger.id}
                                  onClick={() => void handleTestTrigger(trigger.id)}
                                  className="flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 disabled:opacity-50 transition-colors"
                                >
                                  <Play className="w-3 h-3" />
                                  {testingTrigger === trigger.id
                                    ? 'Testing…'
                                    : 'Test to load fields'}
                                </button>
                              ) : (
                                <p className="text-xs text-subtle">No fields available</p>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        <CategorySection
          label="Nodes"
          icon={Layers}
          nodes={filteredSteps}
          onSelect={onSelect}
          expandedKeys={expandedKeys}
          onToggle={handleToggle}
          categoryKey="__category_steps"
        />

        {(!searchQuery || filteredMemory.length > 0) && (
          <CategorySection
            label="Memory"
            icon={Brain}
            nodes={filteredMemory}
            onSelect={onSelect}
            expandedKeys={expandedKeys}
            onToggle={handleToggle}
            categoryKey="__category_memory"
            infoTooltip="Persistent state across runs. Write via Function nodes (memory.workflow.set / memory.project.set)."
          />
        )}

        {isAgentWorkflow && (!searchQuery || filteredAgentSession.length > 0) && (
          <CategorySection
            label="Agent Session"
            icon={Bot}
            nodes={filteredAgentSession}
            onSelect={onSelect}
            expandedKeys={expandedKeys}
            onToggle={handleToggle}
            categoryKey="__category_agent_session"
            infoTooltip="Identity of the calling agent and end-user. Populated only when invoked as a tool from an agent."
          />
        )}

        {isAgentWorkflow && (!searchQuery || filteredAgentContext.length > 0) && (
          <CategorySection
            label="Agent Context"
            icon={Zap}
            nodes={filteredAgentContext}
            onSelect={onSelect}
            expandedKeys={expandedKeys}
            onToggle={handleToggle}
            categoryKey="__category_agent_context"
            infoTooltip="The agent's tool invocation arguments, caller, and attachments. Populated only when invoked as a tool from an agent."
          />
        )}
      </div>

      {/* Footer hint */}
      <div className="px-3 py-2 border-t border-default">
        <p className="text-xs text-subtle text-center">Click a field to insert its expression</p>
      </div>
    </div>
  );
}
