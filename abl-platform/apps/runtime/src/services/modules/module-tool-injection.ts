/**
 * Module Tool Injection
 *
 * Phase 2 of materializeModuleResolvedTools: injects module tools that are
 * referenced by an agent's IR but missing from its tools array. This handles
 * the case where consumer projects import module tools (read-only/use-only)
 * without writing DSL stubs for them.
 *
 * Two injection rules:
 * 1. Consumer agents: inject if the tool is explicitly referenced in flow steps,
 *    reasoning zones, etc.
 * 2. Module agents (have _moduleProvenance): inject all tools from the same alias
 *    (module's own tools).
 */

import type { AgentIR, ToolDefinition } from '@abl/compiler';
import type { ResolvedAgentIR, ResolvedToolDefinition } from './types.js';

/**
 * Collect all tool names referenced in an agent's IR (flow steps, reasoning zones).
 * Used to determine which module tools need to be injected.
 *
 * Returns a Set of tool names — ephemeral, scoped to a single call (no eviction needed).
 */
export function collectToolReferences(agent: AgentIR): Set<string> {
  const refs = new Set<string>();

  // Scan flow definitions: call, call_spec.tool, reasoning_zone.available_tools
  const defs = agent.flow?.definitions;
  if (defs) {
    for (const step of Object.values(defs)) {
      if (step.call) {
        refs.add(step.call);
      }
      if (step.call_spec?.tool) {
        refs.add(step.call_spec.tool);
      }
      if (step.reasoning_zone?.available_tools) {
        for (const t of step.reasoning_zone.available_tools) {
          refs.add(t);
        }
      }
      // on_success / on_failure call blocks
      const stepRecord = step as unknown as Record<string, unknown>;
      for (const blockKey of ['on_success', 'on_failure'] as const) {
        const block = stepRecord[blockKey];
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (typeof b['call'] === 'string') {
            refs.add(b['call']);
          }
        }
      }
    }
  }

  // Scan staticGraph nodes for call references (mirrors definitions but may diverge)
  const nodes = agent.flow?.staticGraph?.nodes;
  if (nodes) {
    for (const node of nodes) {
      if (node.step?.call) {
        refs.add(node.step.call);
      }
    }
  }

  // Scan coordination context for tool references
  const coord = agent.coordination;
  if (coord) {
    // Escalation connector_action is a tool name (e.g., 'servicenow_create_incident')
    if (coord.escalation?.connector_action) {
      refs.add(coord.escalation.connector_action);
    }
  }

  return refs;
}

/**
 * Inject missing module tools into agents that reference them but don't have
 * them in their tools array.
 *
 * existingToolNames is an ephemeral Set — scoped to a single call, .clear()ed before return.
 */
export function injectMissingModuleTools(
  agent: AgentIR,
  resolvedTools: Record<string, ResolvedToolDefinition>,
): void {
  const existingToolNames = new Set((agent.tools ?? []).map((t) => t.name));

  const resolvedAgent = agent as ResolvedAgentIR;
  const provenance = resolvedAgent._moduleProvenance;

  if (provenance) {
    // Module agent: inject all tools from the same alias prefix
    const aliasPrefix = provenance.alias + '__';
    for (const [toolName, toolDef] of Object.entries(resolvedTools)) {
      if (toolName.startsWith(aliasPrefix) && !existingToolNames.has(toolName)) {
        if (!agent.tools) {
          agent.tools = [];
        }
        agent.tools.push(toolDef as unknown as ToolDefinition);
        existingToolNames.add(toolName);
      }
    }
  } else {
    // Consumer agent: inject only tools explicitly referenced in IR
    const refs = collectToolReferences(agent);
    for (const refName of refs) {
      if (!existingToolNames.has(refName)) {
        const resolvedTool = resolvedTools[refName];
        if (resolvedTool) {
          if (!agent.tools) {
            agent.tools = [];
          }
          agent.tools.push(resolvedTool as unknown as ToolDefinition);
          existingToolNames.add(refName);
        }
      }
    }
    refs.clear();
  }

  existingToolNames.clear();
}
