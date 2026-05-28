'use client';

import { useMemo, useState, useEffect, useCallback } from 'react';
import { FUNCTION_CONTEXT_RESERVED_TOP_LEVEL_KEYS } from '@agent-platform/shared-kernel/types';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';
import { useNavigationStore } from '../../../../store/navigation-store';
import { listWorkflowTriggers, getTriggerSamplePayload } from '../../../../api/workflows';
import type { WorkflowTrigger } from '../../../../api/workflows';

export interface WorkflowPreviousStep {
  id: string;
  name: string;
  outputSchema?: Record<string, unknown>;
  /**
   * Canvas node id (distinct from `id`, which is the runtime step label).
   * Set for integration nodes so the Expression Browser can open the Test
   * Action modal for the right node.
   */
  canvasNodeId?: string;
  /**
   * True when this is an integration node that has not yet been tested.
   * The Explorer renders a "Test action" row inside the data subtree to
   * let the user load real fields.
   */
  needsTestAction?: boolean;
  /**
   * For integration nodes — connector short name (e.g. "gmail"). Used by the
   * Expression Browser tree to render the connector logo on the step row.
   */
  connectorName?: string;
}

export interface TriggerOption {
  id: string;
  /** Trigger-only display name (e.g. "New Email Received") — no connector prefix. */
  label: string;
  /** Connector short name (e.g. "gmail", "slack") — used to render the integration logo. */
  connectorName?: string;
  /**
   * Connection id this trigger is bound to. The Explorer resolves this to the
   * connection / auth-profile display name at render time. After ABLP-913 this
   * id may point at an AuthProfile directly — the resolver handles both.
   */
  connectionId?: string;
  payload: Record<string, unknown>;
}

// Output schemas — all keyed to ctx.steps[name].output.* (consistent path for all node types).
// function is omitted: user return value is opaque, explorer shows single {{steps.X.output}} leaf.
// Internal/telemetry fields (sessionId, traceEvents, responseMetadata, respondedAt, notes, ...)
// resolve at runtime but are hidden from authoring — workflow authors don't
// compose them into expressions.
const AGENT_OUTPUT = {
  agentResponse: 'string',
  action: 'string',
  sessionEnded: 'boolean',
};

/** Map a Data Entry / Human form field type to a schema scalar type. */
function fieldTypeToSchemaType(fieldType: string): string {
  switch (fieldType) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    // text, textarea, select, date all serialize as strings at runtime
    default:
      return 'string';
  }
}

/**
 * Return a placeholder value matching the declared type of a workflow input
 * variable. Used so suggestion popups show shape-appropriate stand-ins
 * (`""`, `0`, `false`, `{}`, `[]`) instead of rendering the type name as the
 * value.
 */
function placeholderForType(declaredType: string): unknown {
  switch (declaredType) {
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'object':
      return {};
    case 'array':
      return [];
    case 'string':
    default:
      return '';
  }
}

/**
 * Build the output schema for a Human / Data Entry node from its configured
 * fields. The runtime emits humanTaskResponse.fields.<name> = <value> for each
 * field the user defined, so we expose those specific keys (with their declared
 * types) rather than a generic `fields: object`. respondedBy and decision are
 * always emitted by the runtime regardless of node config.
 */
export function buildHumanOutputSchema(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const rawFields = (config?.fields as Array<{ name?: unknown; type?: unknown }> | undefined) ?? [];
  const fieldsSchema: Record<string, string> = {};
  for (const f of rawFields) {
    if (typeof f?.name !== 'string' || !f.name.trim()) continue;
    const fieldType = typeof f.type === 'string' ? f.type : 'text';
    fieldsSchema[f.name] = fieldTypeToSchemaType(fieldType);
  }
  return {
    humanTaskResponse: {
      respondedBy: 'string',
      decision: 'string',
      fields: Object.keys(fieldsSchema).length > 0 ? fieldsSchema : 'object',
    },
  };
}

/**
 * Reserved top-level keys for parsed function-output schema filtering.
 *
 * Sourced from `@agent-platform/shared-kernel` so the engine's runtime
 * write-ban policy and this parser cannot drift. If the engine adds or
 * removes a reserved key, the shared constant updates and this filter
 * follows automatically.
 *
 * `vars` is added defensively on top of the shared set: the engine's
 * write-ban policy doesn't currently include it (writes to `context.vars`
 * are technically allowed at runtime), but those writes clobber the
 * declared-input-variables namespace and are almost never intended. We
 * exclude `vars` from discoverable outputs so the Expression Browser
 * doesn't surface it as a binding target.
 */
const FUNCTION_RESERVED_KEYS: ReadonlySet<string> = new Set<string>([
  ...FUNCTION_CONTEXT_RESERVED_TOP_LEVEL_KEYS,
  'vars',
]);

export function parseFunctionOutputSchema(
  code: string | undefined,
): Record<string, unknown> | undefined {
  if (!code || typeof code !== 'string') return undefined;
  const writePattern = /\bcontext\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=(?!=)/g;
  const keys = new Set<string>();
  for (const match of code.matchAll(writePattern)) {
    const key = match[1];
    if (FUNCTION_RESERVED_KEYS.has(key)) continue;
    keys.add(key);
  }
  if (keys.size === 0) return undefined;
  const schema: Record<string, unknown> = {};
  for (const key of keys) schema[key] = 'any';
  return schema;
}

const NODE_OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  api: { statusCode: 'number', body: 'any', headers: 'object' },
  delay: { delayMs: 'number' },
  agent: AGENT_OUTPUT,
  agentic_app: AGENT_OUTPUT,
  text_to_text: AGENT_OUTPUT,
  text_to_image: AGENT_OUTPUT,
  audio_to_text: AGENT_OUTPUT,
  image_to_text: AGENT_OUTPUT,
  // tool omitted: output shape depends on the specific tool implementation.
  // searchai has a fixed schema — see TOOL_TYPE_OUTPUT_SCHEMAS below.
  // http and sandbox outputs are dynamic/opaque — no schema is registered.
  loop: { iterations: 'number', items: 'array' },
  condition: { conditionMet: 'boolean', branchTaken: 'string' },
  // human / data_entry handled dynamically — schema depends on the node's
  // configured fields (see buildHumanOutputSchema in the previousSteps map).
  // integration: omitted — output is the raw provider response and its shape
  // depends entirely on the picked action. Until the user runs "Test action",
  // we surface a single `output: any` leaf via the needsTestAction path below.
};

const HUMAN_NODE_TYPES = new Set(['human', 'data_entry']);

// http: omitted — output is the raw HTTP response body (JSON or plain string);
//   shape is entirely determined by the upstream API, not fixed at design time.
// sandbox: omitted — output is whatever the sandbox code returns; shape is opaque.
const TOOL_TYPE_OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  searchai: { queryType: 'string', results: 'array', totalCount: 'number' },
};

function labelForTrigger(trigger: WorkflowTrigger): string {
  // Connector triggers store the real name in config regardless of triggerType value.
  // Return only the trigger-side label (e.g. "New Email Received"); the connector
  // identity is conveyed by the integration logo rendered alongside it.
  const connectorName = (trigger.config?.connectorName as string | undefined) ?? '';
  const triggerName = (trigger.config?.triggerName as string | undefined) ?? '';

  if (connectorName) {
    // Strip connector prefix if present (e.g. "gmail_new_email_received" → "new_email_received")
    // and also strip hyphenated prefix (e.g. "new-direct-message" stays as-is).
    const withoutPrefix = triggerName.startsWith(connectorName + '_')
      ? triggerName.slice(connectorName.length + 1)
      : triggerName;
    const displayTrigger = withoutPrefix
      .replace(/[_-]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return displayTrigger || triggerName;
  }
  if (trigger.triggerType === 'cron') return 'Schedule';
  return 'Webhook';
}

/**
 * Returns triggers (registered trigger list with sampled payloads) and
 * previousSteps (all upstream nodes reachable via BFS backward from nodeId).
 *
 * Step id is set to the canvas label — this matches the runtime key
 * ctx.steps[step.name ?? step.id] where step.name = n.data.label.
 */
export function useWorkflowExpressionContext(nodeId: string) {
  const nodes = useWorkflowCanvasStore((s) => s.nodes);
  const edges = useWorkflowCanvasStore((s) => s.edges);
  const executionContext = useWorkflowCanvasStore((s) => s.executionContext);
  const workflowId = useWorkflowCanvasStore((s) => s.workflowId);
  const projectId = useNavigationStore((s) => s.projectId);

  const [connectorTriggers, setConnectorTriggers] = useState<TriggerOption[]>([]);

  // Fetch registered triggers and their sample payloads
  useEffect(() => {
    if (!projectId || !workflowId) return;
    let cancelled = false;

    async function load() {
      try {
        const registered = await listWorkflowTriggers(projectId!, workflowId!);
        if (cancelled) return;

        // Only include ACTIVE connector triggers — paused/error/deleted ones
        // don't reflect what the workflow will actually receive at run-time,
        // so suggesting their payloads would mislead the author.
        const connectorOnly = registered.filter(
          (t) =>
            t.status === 'active' &&
            typeof (t.config?.connectorName as string | undefined) === 'string',
        );

        // allSettled instead of all so a single trigger whose label-builder or
        // sample-fetch unexpectedly throws can't drop every other trigger from
        // the suggestion list. Each fulfilled result is kept; rejections are
        // logged and skipped.
        const settled = await Promise.allSettled(
          connectorOnly.map(async (trigger) => {
            let payload: Record<string, unknown> = {};
            try {
              const sample = await getTriggerSamplePayload(projectId!, trigger.id);
              if (sample && typeof sample === 'object') {
                payload = sample as Record<string, unknown>;
              }
            } catch {
              // sample fetch is best-effort; leave payload as {}
            }
            const connectorName =
              (trigger.config?.connectorName as string | undefined) ?? undefined;
            const connectionId = (trigger.config?.connectionId as string | undefined) ?? undefined;
            return {
              id: trigger.id,
              label: labelForTrigger(trigger),
              connectorName,
              connectionId,
              payload,
            };
          }),
        );

        const options: TriggerOption[] = [];
        for (const r of settled) {
          if (r.status === 'fulfilled') {
            options.push(r.value);
          } else {
            console.warn('[useWorkflowExpressionContext] trigger option failed', r.reason);
          }
        }

        if (!cancelled) setConnectorTriggers(options);
      } catch {
        // silently ignore — trigger suggestions are best-effort
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, workflowId]);

  // Build a "Workflow Input" trigger option from the start node's inputVariables
  // (used for manually-triggered workflows that declare explicit input params).
  const inputVarTrigger = useMemo((): TriggerOption | null => {
    const startNode = nodes.find((n) => n.data.nodeType === 'start');
    if (!startNode) return null;
    const inputVars = startNode.data.config?.inputVariables;
    if (!Array.isArray(inputVars) || inputVars.length === 0) return null;
    const payload: Record<string, unknown> = {};
    for (const v of inputVars) {
      if (
        typeof v === 'object' &&
        v !== null &&
        typeof (v as Record<string, unknown>).name === 'string'
      ) {
        const name = (v as Record<string, unknown>).name as string;
        const declaredType = (v as Record<string, unknown>).type;
        // Store a placeholder VALUE matching the declared type so the Expression
        // Browser / IntelliSense renders `userName: ""` rather than
        // `userName: "string"` (the literal type name treated as the value).
        payload[name] = placeholderForType(
          typeof declaredType === 'string' ? declaredType : 'string',
        );
      }
    }
    return { id: '__input_vars', label: 'Workflow Input', payload };
  }, [nodes]);

  const refreshTrigger = useCallback((triggerId: string, payload: Record<string, unknown>) => {
    setConnectorTriggers((prev) => prev.map((t) => (t.id === triggerId ? { ...t, payload } : t)));
  }, []);

  const triggers = useMemo((): TriggerOption[] => {
    const all: TriggerOption[] = [...connectorTriggers];
    if (inputVarTrigger) all.push(inputVarTrigger);
    return all;
  }, [connectorTriggers, inputVarTrigger]);

  const previousSteps = useMemo((): WorkflowPreviousStep[] => {
    const visited = new Set<string>();
    const queue: string[] = [];

    for (const edge of edges) {
      if (edge.target === nodeId) {
        queue.push(edge.source);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of edges) {
        if (edge.target === current) {
          queue.push(edge.source);
        }
      }
    }

    return nodes
      .filter((n) => visited.has(n.id) && n.data.nodeType !== 'start')
      .map((n): WorkflowPreviousStep => {
        const label = n.data.label ?? n.id;
        let outputSchema = NODE_OUTPUT_SCHEMAS[n.data.nodeType] ?? undefined;
        let needsTestAction = false;
        if (n.data.nodeType === 'tool') {
          const toolType = n.data.config?.toolType as string | undefined;
          outputSchema = (toolType && TOOL_TYPE_OUTPUT_SCHEMAS[toolType]) || outputSchema;
        } else if (HUMAN_NODE_TYPES.has(n.data.nodeType)) {
          outputSchema = buildHumanOutputSchema(n.data.config);
        } else if (n.data.nodeType === 'integration') {
          // Integration nodes return the raw provider response at runtime
          // (no envelope) — so the design-time schema is whatever the user
          // captured via "Test action". Until that's run, mark the node so
          // the Explorer injects a "Test action" row prompting the user to
          // load real fields.
          const sampleOutput = n.data.config?.sampleOutput;
          if (sampleOutput && typeof sampleOutput === 'object' && !Array.isArray(sampleOutput)) {
            outputSchema = sampleOutput as Record<string, unknown>;
          } else {
            needsTestAction = true;
          }
        } else if (n.data.nodeType === 'function') {
          const parsed = parseFunctionOutputSchema(n.data.config?.code as string | undefined);
          if (parsed) outputSchema = parsed;
        }
        const connectorName =
          n.data.nodeType === 'integration'
            ? ((n.data.config?.connectorId as string | undefined) ?? undefined)
            : undefined;
        return {
          id: label,
          name: label,
          outputSchema,
          canvasNodeId: n.id,
          needsTestAction,
          connectorName,
        };
      });
  }, [nodes, edges, nodeId]);

  return { triggers, previousSteps, refreshTrigger, executionContext };
}
