/**
 * useWorkflowValidation
 *
 * Validates the current canvas state and updates the store's validationIssues.
 * Runs whenever nodes or edges change.
 */

import { useEffect } from 'react';
import { useWorkflowCanvasStore } from '../../../store/workflow-canvas-store';
import type { ValidationIssue } from '../../../store/workflow-canvas-store';
import { STUB_NODE_TYPES } from '@agent-platform/shared-kernel/types';
import { VAR_NAME_REGEX } from './constants/workflow';

const NAME_PATTERN = /^[A-Za-z0-9_]+$/;
const VAR_NAME_PATTERN = VAR_NAME_REGEX;

// Delay bounds — must stay in sync with DELAY_MIN_SECONDS / DELAY_MAX_SECONDS
// in GenericNodeConfig.tsx. Mirrors user-app-ui's designer-constants.ts.
const DELAY_MIN_SECONDS = 5;
const DELAY_MAX_SECONDS = 86400;
const DELAY_UNIT_TO_SECONDS: Record<string, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
};

export function useWorkflowValidation(): void {
  const nodes = useWorkflowCanvasStore((s) => s.nodes);
  const edges = useWorkflowCanvasStore((s) => s.edges);
  const setValidationIssues = useWorkflowCanvasStore((s) => s.setValidationIssues);

  useEffect(() => {
    const issues: ValidationIssue[] = [];

    // 1. No start node
    const hasStart = nodes.some((n) => n.data.nodeType === 'start');
    if (!hasStart) {
      issues.push({ severity: 'error', message: 'Workflow must have a Start node' });
    }

    // 2. No end node
    const hasEnd = nodes.some((n) => n.data.nodeType === 'end');
    if (!hasEnd) {
      issues.push({ severity: 'error', message: 'Workflow must have an End node' });
    }

    // 3. Disconnected nodes (no incoming AND no outgoing edges, except Start)
    const sourceIds = new Set(edges.map((e) => e.source));
    const targetIds = new Set(edges.map((e) => e.target));

    // 3a. End node must have at least one incoming connection
    for (const node of nodes) {
      if (node.data.nodeType === 'end' && !targetIds.has(node.id)) {
        issues.push({
          severity: 'error',
          message: `End node "${node.data.label}" has no incoming connection`,
          nodeId: node.id,
        });
      }
    }
    for (const node of nodes) {
      if (node.data.nodeType === 'start') continue;
      const hasIncoming = targetIds.has(node.id);
      const hasOutgoing = sourceIds.has(node.id);
      if (!hasIncoming && !hasOutgoing) {
        issues.push({
          severity: 'warning',
          message: `Node "${node.data.label}" is disconnected`,
          nodeId: node.id,
        });
      }
    }

    // 4. Duplicate node names
    const nameCount = new Map<string, string[]>();
    for (const node of nodes) {
      const name = node.data.label;
      const existing = nameCount.get(name);
      if (existing) {
        existing.push(node.id);
      } else {
        nameCount.set(name, [node.id]);
      }
    }
    for (const [name, ids] of nameCount) {
      if (ids.length > 1) {
        for (const nodeId of ids) {
          issues.push({
            severity: 'error',
            message: `Duplicate node name: "${name}"`,
            nodeId,
          });
        }
      }
    }

    // 5. Stub nodes used
    for (const node of nodes) {
      if (STUB_NODE_TYPES.includes(node.data.nodeType)) {
        issues.push({
          severity: 'error',
          message: `Stub nodes cannot be deployed: ${node.data.label}`,
          nodeId: node.id,
        });
      }
    }

    // 6. Node name invalid characters
    for (const node of nodes) {
      if (!NAME_PATTERN.test(node.data.label)) {
        issues.push({
          severity: 'error',
          message: `Node name "${node.data.label}" contains invalid characters (use A-Z, 0-9, _)`,
          nodeId: node.id,
        });
      }
    }

    // 7. Integration nodes must have a connector and action selected.
    // Without these, canvas-to-steps emits an empty connector/action pair and
    // the executor fails at runtime with a "tool not found" error. Catch it
    // at save time instead.
    for (const node of nodes) {
      if (node.data.nodeType !== 'integration') continue;
      const config = (node.data.config ?? {}) as Record<string, unknown>;
      const connector = (config.connectorId ?? config.connector) as string | undefined;
      const action = (config.actionName ?? config.action) as string | undefined;
      if (!connector || connector.length === 0) {
        issues.push({
          severity: 'error',
          message: `Integration node "${node.data.label}" has no connector selected`,
          nodeId: node.id,
        });
      }
      if (!action || action.length === 0) {
        issues.push({
          severity: 'error',
          message: `Integration node "${node.data.label}" has no action selected`,
          nodeId: node.id,
        });
      }
    }

    // 8. Delay nodes must be within the configured bounds. Out-of-range
    // delays would be rejected by the engine (or silently truncated) — catch
    // them here so the user sees the issue badge and Run is blocked.
    for (const node of nodes) {
      if (node.data.nodeType !== 'delay') continue;
      const config = (node.data.config ?? {}) as Record<string, unknown>;
      const rawDuration = config.duration as number | string | undefined;
      const unit = (config.unit as string) ?? 'seconds';
      const numeric = typeof rawDuration === 'number' ? rawDuration : Number(rawDuration);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        issues.push({
          severity: 'error',
          message: `Delay node "${node.data.label}" needs a positive duration`,
          nodeId: node.id,
        });
        continue;
      }
      const totalSeconds = numeric * (DELAY_UNIT_TO_SECONDS[unit] ?? 1);
      if (totalSeconds < DELAY_MIN_SECONDS) {
        issues.push({
          severity: 'error',
          message: `Delay node "${node.data.label}" is below the ${DELAY_MIN_SECONDS}s minimum`,
          nodeId: node.id,
        });
      } else if (totalSeconds > DELAY_MAX_SECONDS) {
        issues.push({
          severity: 'error',
          message: `Delay node "${node.data.label}" exceeds the 24h maximum`,
          nodeId: node.id,
        });
      }
    }

    // 9. Start node input variables must each have a valid identifier name.
    // Empty / malformed names would pass straight to the executor and the
    // execution would silently run with an unnamed variable in its inputs.
    for (const node of nodes) {
      if (node.data.nodeType !== 'start') continue;
      const config = (node.data.config ?? {}) as Record<string, unknown>;
      const vars = (config.inputVariables as Array<{ name?: string }>) ?? [];
      const seen = new Map<string, number>();
      vars.forEach((v, i) => {
        const trimmed = (v?.name ?? '').trim();
        if (!trimmed) {
          issues.push({
            severity: 'error',
            message: `Start node input variable at position ${i + 1} has no name`,
            nodeId: node.id,
          });
          return;
        }
        if (!VAR_NAME_PATTERN.test(trimmed)) {
          issues.push({
            severity: 'error',
            message: `Start node input "${trimmed}" has an invalid name (use letters, digits, _)`,
            nodeId: node.id,
          });
          return;
        }
        seen.set(trimmed, (seen.get(trimmed) ?? 0) + 1);
      });
      for (const [name, count] of seen) {
        if (count > 1) {
          issues.push({
            severity: 'error',
            message: `Start node has duplicate input variable name "${name}"`,
            nodeId: node.id,
          });
        }
      }
    }

    setValidationIssues(issues);
  }, [nodes, edges, setValidationIssues]);
}
