/**
 * Import Analyzer
 *
 * Auto-detects import format (Agent Platform v12 or XO11),
 * extracts entities, and identifies ABL gaps.
 */

import type {
  ImportFormat,
  ImportAnalysis,
  EntityMapping,
  AgentPlatformExport,
  XO11Export,
} from './types.js';
import { detectAgentPlatformGaps, detectXO11Gaps } from '../architect/gaps.js';
import { toAgentName, toToolName, extractBrief } from './mapping.js';

// =============================================================================
// FORMAT DETECTION
// =============================================================================

/**
 * Auto-detect the import format from JSON
 */
export function detectFormat(json: unknown): ImportFormat {
  if (!json || typeof json !== 'object') return 'unknown';

  const obj = json as Record<string, unknown>;

  // Agent Platform v12: has orchestrationPrompt + MCPServers + agents with subType
  if (obj.app && obj.MCPServers && obj.agents) {
    const app = obj.app as Record<string, unknown>;
    if (app.orchestrationPrompt) return 'agent-platform';
  }

  // XO11: has dialogFlows/dialogTasks + entity/message/webhook nodes
  if (obj.dialogFlows || obj.dialogTasks) return 'xo11';

  // Also check for agent-platform without orchestrationPrompt
  if (obj.agents && obj.MCPServers) return 'agent-platform';

  return 'unknown';
}

// =============================================================================
// MAIN ANALYZER
// =============================================================================

/**
 * Analyze an import JSON and produce a conversion plan.
 */
export function analyzeImport(json: unknown): ImportAnalysis {
  const format = detectFormat(json);

  switch (format) {
    case 'agent-platform':
      return analyzeAgentPlatform(json as AgentPlatformExport);
    case 'xo11':
      return analyzeXO11(json as XO11Export);
    default:
      throw new Error(
        'Unknown import format. Expected either:\n' +
          '- Kore.ai Agent Platform v12 export (with app, MCPServers, agents)\n' +
          '- Kore.ai XO11 export (with dialogFlows/dialogTasks)',
      );
  }
}

// =============================================================================
// AGENT PLATFORM v12 ANALYSIS
// =============================================================================

function analyzeAgentPlatform(data: AgentPlatformExport): ImportAnalysis {
  const mappings: EntityMapping[] = [];
  const agents: string[] = [];
  const tools: string[] = [];

  // Extract agents
  for (const agent of data.agents || []) {
    const ablName = toAgentName(agent.name);
    agents.push(agent.name);
    mappings.push({
      source: agent.name,
      sourceType: 'agent',
      target: ablName,
      targetType: 'AGENT',
      notes: agent.subType ? `subType: ${agent.subType}` : undefined,
    });
  }

  // Extract tools from MCPServers
  for (const server of data.MCPServers || []) {
    for (const tool of server.tools || []) {
      const ablName = toToolName(tool.name);
      tools.push(tool.name);
      mappings.push({
        source: `${server.name}/${tool.name}`,
        sourceType: 'tool',
        target: ablName,
        targetType: 'TOOL',
        notes: tool.description ? extractBrief(tool.description) : undefined,
      });
    }
  }

  // Map supervisor/orchestration
  const hasSupervisor = !!data.app?.orchestrationPrompt?.custom;
  if (hasSupervisor) {
    mappings.push({
      source: 'app.orchestrationPrompt',
      sourceType: 'orchestration',
      target: 'Supervisor',
      targetType: 'SUPERVISOR',
      notes: 'Multi-level routing decision tree',
    });
  }

  // Map memory stores
  for (const store of data.app?.memoryStores || []) {
    const storeName =
      store.memoryStoreName || store.name || store.technicalMemoryKey || 'unnamed_store';
    mappings.push({
      source: storeName,
      sourceType: 'memoryStore',
      target: storeName,
      targetType: 'MEMORY',
    });
  }

  // Detect gaps
  const gapReport = detectAgentPlatformGaps(data);

  const description =
    `Kore.ai Agent Platform v12 export with ${agents.length} agent(s), ` +
    `${tools.length} tool(s)${hasSupervisor ? ', supervisor routing' : ''}`;

  return {
    format: 'agent-platform',
    summary: {
      agentCount: agents.length,
      toolCount: tools.length,
      supervisorDetected: hasSupervisor,
      description,
    },
    mappings,
    gapReport,
    suggestedTopology:
      hasSupervisor && agents.length > 1
        ? 'supervisor'
        : agents.length > 1
          ? 'adaptive-network'
          : 'single-agent',
    rawEntities: {
      agents,
      tools,
    },
  };
}

// =============================================================================
// XO11 ANALYSIS
// =============================================================================

function analyzeXO11(data: XO11Export): ImportAnalysis {
  const mappings: EntityMapping[] = [];
  const flows: string[] = [];
  const tools: string[] = [];
  const intents: string[] = [];

  const dialogFlows = data.dialogFlows || data.dialogTasks || [];

  // Extract dialog flows -> agents
  for (const flow of dialogFlows) {
    const ablName = toAgentName(flow.name);
    flows.push(flow.name);
    mappings.push({
      source: flow.name,
      sourceType: 'dialogFlow',
      target: ablName,
      targetType: 'AGENT',
      notes: flow.intent ? `intent: ${flow.intent}` : undefined,
    });

    if (flow.intent) {
      intents.push(flow.intent);
    }

    // Map nodes within flow
    for (const node of flow.nodes || []) {
      if ('url' in node) {
        // Webhook node -> TOOL
        const toolName = toToolName(node.name);
        tools.push(node.name);
        mappings.push({
          source: `${flow.name}/${node.name}`,
          sourceType: 'webhookNode',
          target: toolName,
          targetType: 'TOOL',
        });
      } else if ('script' in node) {
        // Script node -> GAP
        mappings.push({
          source: `${flow.name}/${node.name}`,
          sourceType: 'scriptNode',
          target: toToolName(node.name),
          targetType: 'TOOL',
          notes: 'GAP: Script nodes must be reimplemented as TOOLS',
        });
      } else if ('message' in node) {
        // Message node -> RESPOND step
        mappings.push({
          source: `${flow.name}/${node.name}`,
          sourceType: 'messageNode',
          target: `${toToolName(node.name)}_step`,
          targetType: 'FLOW_STEP',
        });
      } else if ('prompt' in node || 'patterns' in node) {
        // Entity node -> GATHER field
        mappings.push({
          source: `${flow.name}/${node.name}`,
          sourceType: 'entityNode',
          target: toToolName(node.name),
          targetType: 'GATHER_FIELD',
        });
      }
    }
  }

  // Extract standalone nodes
  for (const node of data.entityNodes || []) {
    mappings.push({
      source: node.name,
      sourceType: 'entityNode',
      target: toToolName(node.name),
      targetType: 'GATHER_FIELD',
    });
  }

  for (const node of data.webhookNodes || []) {
    const toolName = toToolName(node.name);
    tools.push(node.name);
    mappings.push({
      source: node.name,
      sourceType: 'webhookNode',
      target: toolName,
      targetType: 'TOOL',
    });
  }

  for (const node of data.scriptNodes || []) {
    mappings.push({
      source: node.name,
      sourceType: 'scriptNode',
      target: toToolName(node.name),
      targetType: 'TOOL',
      notes: 'GAP: Script nodes must be reimplemented as TOOLS',
    });
  }

  // Detect gaps
  const gapReport = detectXO11Gaps(data);

  const hasSupervisor = dialogFlows.length > 1;

  return {
    format: 'xo11',
    summary: {
      agentCount: dialogFlows.length,
      toolCount: tools.length,
      flowCount: dialogFlows.length,
      supervisorDetected: hasSupervisor,
      description: `XO11 export with ${dialogFlows.length} dialog flow(s), ${tools.length} tool(s)`,
    },
    mappings,
    gapReport,
    suggestedTopology: hasSupervisor ? 'supervisor' : 'single-agent',
    rawEntities: {
      agents: flows,
      tools,
      flows,
      intents,
    },
  };
}
