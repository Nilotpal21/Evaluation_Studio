/**
 * App-Level Graph Extractor
 *
 * Extracts a combined static graph from multiple agents for app-level visualization.
 * Shows all agents in an app with their internal flows and inter-agent connections.
 */

import type {
  AgentIR,
  SupervisorIR,
  CompilationOutput,
  AppConfig,
  AppStaticGraph,
  InterAgentEdge,
  AppLayoutHints,
  AgentConnection,
  StaticGraph,
} from './schema.js';

/**
 * Find the supervisor agent (if any) from the agents map.
 * A supervisor is an agent with routing configured.
 */
function findSupervisor(compilation: CompilationOutput): SupervisorIR | undefined {
  const entryName = compilation.entry_agent;
  if (entryName && compilation.agents[entryName]?.routing) {
    return compilation.agents[entryName] as SupervisorIR;
  }
  // Fallback: find any agent with routing
  for (const agent of Object.values(compilation.agents)) {
    if (agent.routing) return agent as SupervisorIR;
  }
  return undefined;
}

/**
 * Extract an app-level static graph from a compilation output
 */
export function extractAppStaticGraph(
  compilation: CompilationOutput,
  appName: string,
): AppStaticGraph {
  const supervisor = findSupervisor(compilation);
  const agents = compilation.agents;

  // Determine entry agent
  const entryAgent = supervisor?.metadata.name || Object.keys(agents)[0];

  // Build app config
  const appConfig: AppConfig = {
    name: appName,
    entryAgent,
    agents: Object.keys(agents),
    connections: extractConnections(supervisor, agents),
  };

  // Ensure supervisor is first in the agents list
  if (supervisor && appConfig.agents[0] !== supervisor.metadata.name) {
    appConfig.agents = [
      supervisor.metadata.name,
      ...appConfig.agents.filter((a) => a !== supervisor.metadata.name),
    ];
  }

  // Extract individual agent static graphs
  const agentGraphs: Record<string, StaticGraph> = {};

  // Add supervisor graph (if exists)
  if (supervisor) {
    agentGraphs[supervisor.metadata.name] = generateSupervisorGraph(
      supervisor,
      appConfig.connections,
    );
  }

  // Add agent graphs
  for (const [name, agent] of Object.entries(agents)) {
    if (agent.flow?.staticGraph) {
      agentGraphs[name] = agent.flow.staticGraph;
    } else {
      // Generate a placeholder graph for reasoning-mode agents
      agentGraphs[name] = generateReasoningAgentGraph(agent);
    }
  }

  // Build inter-agent edges
  const interAgentEdges = buildInterAgentEdges(appConfig.connections, agentGraphs);

  // Generate layout hints
  const layout = generateLayoutHints(appConfig, agentGraphs);

  return {
    app: appConfig,
    agentGraphs,
    interAgentEdges,
    layout,
  };
}

/**
 * Extract connections from supervisor handoffs and agent delegates
 */
function extractConnections(
  supervisor: SupervisorIR | undefined,
  agents: Record<string, AgentIR>,
): AgentConnection[] {
  const connections: AgentConnection[] = [];

  // Extract from supervisor handoffs
  if (supervisor) {
    for (const handoff of supervisor.coordination.handoffs) {
      connections.push({
        from: supervisor.metadata.name,
        to: handoff.to,
        type: 'handoff',
        when: handoff.when,
        returns: handoff.return,
        label: handoff.context.summary,
        experienceMode: handoff.experienceMode,
      });
    }
  }

  // Extract from agent delegates and handoffs
  for (const [name, agent] of Object.entries(agents)) {
    // Delegates
    for (const delegate of agent.coordination.delegates) {
      connections.push({
        from: name,
        to: delegate.agent,
        type: 'delegate',
        when: delegate.when,
        returns: true, // delegates always return
        label: delegate.purpose,
        experienceMode: delegate.experienceMode,
      });
    }

    // Handoffs from agents
    for (const handoff of agent.coordination.handoffs) {
      connections.push({
        from: name,
        to: handoff.to,
        type: 'handoff',
        when: handoff.when,
        returns: handoff.return,
        label: handoff.context.summary,
        experienceMode: handoff.experienceMode,
      });
    }

    // Extract from flow digressions (if scripted mode)
    if (agent.flow?.definitions) {
      for (const [stepName, step] of Object.entries(agent.flow.definitions)) {
        if (step.digressions) {
          for (const digression of step.digressions) {
            const delegateActions =
              digression.do && digression.do.length > 0
                ? digression.do.filter(
                    (action): action is typeof action & { delegate: string } => !!action.delegate,
                  )
                : digression.delegate
                  ? [{ delegate: digression.delegate, return: false }]
                  : [];

            for (const action of delegateActions) {
              connections.push({
                from: name,
                to: action.delegate,
                type: 'delegate',
                when: `intent: ${digression.intent}`,
                returns: action.return ?? false,
                label: digression.intent,
              });
            }
          }
        }
      }
    }
  }

  return connections;
}

/**
 * Generate a static graph for supervisors (which don't have FLOW)
 */
function generateSupervisorGraph(
  supervisor: SupervisorIR,
  connections: AgentConnection[],
): StaticGraph {
  const nodes: StaticGraph['nodes'] = [];
  const edges: StaticGraph['edges'] = [];

  // Entry node
  nodes.push({
    id: '__entry__',
    type: 'entry',
    label: 'Start',
    deterministic: true,
  });

  // Intent classification node (LLM decision)
  const intentNodeId = '__intent_classifier__';
  nodes.push({
    id: intentNodeId,
    type: 'llm_decision',
    label: 'Intent Classification',
    deterministic: false,
    conditions: supervisor.routing.rules.map((r) => r.when),
  });

  edges.push({
    id: '__entry__->intent',
    from: '__entry__',
    to: intentNodeId,
    type: 'sequential',
  });

  // Create nodes for each routing target
  const handoffTargets = new Set(
    connections.filter((c) => c.from === supervisor.metadata.name).map((c) => c.to),
  );

  for (const target of handoffTargets) {
    const handoffNodeId = `__handoff_${target}__`;
    nodes.push({
      id: handoffNodeId,
      type: 'step',
      label: `→ ${target}`,
      deterministic: true,
      step: {
        respond: `Handoff to ${target}`,
      },
    });

    // Edge from intent classifier to handoff
    const connection = connections.find(
      (c) => c.from === supervisor.metadata.name && c.to === target,
    );
    edges.push({
      id: `${intentNodeId}->${handoffNodeId}`,
      from: intentNodeId,
      to: handoffNodeId,
      type: 'digression',
      label: connection?.label || target,
    });
  }

  // Exit node
  nodes.push({
    id: '__exit__',
    type: 'exit',
    label: 'End',
    deterministic: true,
  });

  return {
    nodes,
    edges,
    entryPoint: '__entry__',
  };
}

/**
 * Generate a placeholder graph for reasoning-mode agents
 */
function generateReasoningAgentGraph(agent: AgentIR): StaticGraph {
  const nodes: StaticGraph['nodes'] = [];
  const edges: StaticGraph['edges'] = [];

  // Entry node
  nodes.push({
    id: '__entry__',
    type: 'entry',
    label: 'Start',
    deterministic: true,
  });

  // Main reasoning node
  nodes.push({
    id: '__reasoning__',
    type: 'llm_decision',
    label: agent.metadata.name,
    deterministic: false,
    conditions: agent.tools.map((t) => t.name),
  });

  edges.push({
    id: '__entry__->reasoning',
    from: '__entry__',
    to: '__reasoning__',
    type: 'sequential',
  });

  // Tool nodes (if any)
  for (const tool of agent.tools) {
    const toolNodeId = `__tool_${tool.name}__`;
    nodes.push({
      id: toolNodeId,
      type: 'step',
      label: tool.name,
      deterministic: true,
      step: {
        call: tool.name,
      },
    });

    edges.push({
      id: `__reasoning__->${toolNodeId}`,
      from: '__reasoning__',
      to: toolNodeId,
      type: 'digression',
      label: tool.name,
    });

    // Tool loops back to reasoning
    edges.push({
      id: `${toolNodeId}->__reasoning__`,
      from: toolNodeId,
      to: '__reasoning__',
      type: 'sequential',
      label: 'result',
    });
  }

  // Exit node
  nodes.push({
    id: '__exit__',
    type: 'exit',
    label: 'End',
    deterministic: true,
  });

  edges.push({
    id: '__reasoning__->exit',
    from: '__reasoning__',
    to: '__exit__',
    type: 'sequential',
    label: 'complete',
  });

  return {
    nodes,
    edges,
    entryPoint: '__entry__',
  };
}

/**
 * Build inter-agent edges from connections
 */
function buildInterAgentEdges(
  connections: AgentConnection[],
  agentGraphs: Record<string, StaticGraph>,
): InterAgentEdge[] {
  const edges: InterAgentEdge[] = [];

  for (const conn of connections) {
    // Find the handoff node in the source agent
    let fromNode: string | undefined;
    const sourceGraph = agentGraphs[conn.from];
    if (sourceGraph) {
      // Look for a handoff node targeting this agent
      const handoffNode = sourceGraph.nodes.find(
        (n) => n.id.includes(`handoff_${conn.to}`) || n.label?.includes(conn.to),
      );
      fromNode = handoffNode?.id;
    }

    // Target is always the entry point of the target agent
    const targetGraph = agentGraphs[conn.to];
    const toNode = targetGraph?.entryPoint || '__entry__';

    edges.push({
      id: `${conn.from}:${fromNode || 'exit'}->${conn.to}:${toNode}`,
      fromAgent: conn.from,
      fromNode,
      toAgent: conn.to,
      toNode,
      type: conn.type,
      label: conn.label,
      returns: conn.returns,
    });
  }

  return edges;
}

/**
 * Generate layout hints for positioning agents
 */
function generateLayoutHints(
  appConfig: AppConfig,
  agentGraphs: Record<string, StaticGraph>,
): AppLayoutHints {
  const agentPositions: Record<string, { row: number; col: number }> = {};

  // Entry agent at top-left
  agentPositions[appConfig.entryAgent] = { row: 0, col: 0 };

  // Build adjacency from connections
  const adjacency: Record<string, Set<string>> = {};
  for (const conn of appConfig.connections) {
    if (!adjacency[conn.from]) adjacency[conn.from] = new Set();
    adjacency[conn.from].add(conn.to);
  }

  // BFS to assign positions
  const visited = new Set<string>([appConfig.entryAgent]);
  const queue: { agent: string; row: number; col: number }[] = [
    { agent: appConfig.entryAgent, row: 0, col: 0 },
  ];

  while (queue.length > 0) {
    const { agent, row, col } = queue.shift()!;
    const targets = adjacency[agent] || new Set();

    let targetCol = col + 1;
    let targetRow = row;

    for (const target of targets) {
      if (!visited.has(target) && appConfig.agents.includes(target)) {
        visited.add(target);
        agentPositions[target] = { row: targetRow, col: targetCol };
        queue.push({ agent: target, row: targetRow, col: targetCol });
        targetRow++;
      }
    }
  }

  // Assign positions to any unvisited agents
  let unvisitedRow = Object.keys(agentPositions).length;
  for (const agent of appConfig.agents) {
    if (!agentPositions[agent]) {
      agentPositions[agent] = { row: unvisitedRow++, col: 1 };
    }
  }

  return {
    agentPositions,
    entryPosition: 'left',
    direction: 'horizontal',
  };
}

export default extractAppStaticGraph;
