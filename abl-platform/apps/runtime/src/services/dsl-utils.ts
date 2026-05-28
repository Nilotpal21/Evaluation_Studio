/**
 * DSL Utility Functions
 *
 * In-memory DSL parsing and compilation helpers.
 * No filesystem access — works with raw DSL strings from the database.
 */

import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import type { AgentIR, SupervisorIR } from '@abl/compiler';
import type { AgentDetails, TestCase } from '../types/index.js';

// =============================================================================
// SIMPLE ABL PARSER (standalone, no external deps)
// =============================================================================

interface ParsedAgent {
  name: string;
  kind: 'agent' | 'supervisor';
  mode: 'reasoning' | 'scripted';
  goal: string;
  tools: string[];
  gatherFields: string[];
  handoffs: string[];
  constraints: string[];
}

function parseDSLBasic(content: string): ParsedAgent {
  const result: ParsedAgent = {
    name: '',
    kind: 'agent',
    mode: 'reasoning',
    goal: '',
    tools: [],
    gatherFields: [],
    handoffs: [],
    constraints: [],
  };

  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('AGENT:') || line.startsWith('agent:')) {
      result.name = line.substring(6).trim();
      result.kind = 'agent';
    } else if (line.startsWith('SUPERVISOR:') || line.startsWith('supervisor:')) {
      result.name = line.substring(11).trim();
      result.kind = 'supervisor';
    } else if (line.startsWith('MODE:') || line.startsWith('mode:')) {
      const mode = line.substring(5).trim().toLowerCase();
      result.mode = mode === 'scripted' ? 'scripted' : 'reasoning';
    } else if (line.startsWith('GOAL:') || line.startsWith('goal:')) {
      const goalMatch = line.match(/(?:GOAL|goal):\s*"?([^"]+)"?/);
      result.goal = goalMatch ? goalMatch[1] : '';
    }
  }

  const toolMatches = content.match(/^\s+\w+\([^)]*\)\s*->/gm);
  result.tools = toolMatches?.map((m) => m.match(/(\w+)\(/)?.[1] || '').filter(Boolean) || [];

  const gatherSection = content.match(/(?:GATHER|gather):\n([\s\S]*?)(?=\n[A-Za-z_]+:|$)/);
  if (gatherSection) {
    const fieldMatches = gatherSection[1].match(/^\s{2}\w+:$/gm);
    result.gatherFields = fieldMatches?.map((m) => m.trim().replace(':', '')) || [];
  }

  const handoffMatches = content.match(/- TO:\s*(\w+)/g);
  result.handoffs =
    handoffMatches?.map((m) => m.match(/TO:\s*(\w+)/)?.[1] || '').filter(Boolean) || [];

  // Agents with HANDOFF blocks are effectively supervisors even if declared with AGENT:
  if (result.kind === 'agent' && result.handoffs.length > 0) {
    result.kind = 'supervisor';
  }

  const constraintMatches = content.match(/- REQUIRE\s+/g);
  result.constraints = constraintMatches?.map((_, i) => `constraint_${i}`) || [];

  return result;
}

// =============================================================================
// BUILD AGENT DETAILS FROM DSL
// =============================================================================

/**
 * Create AgentDetails from raw DSL content (no filesystem needed).
 * Used for database-backed agents.
 */
export function buildAgentDetails(dsl: string, name: string): AgentDetails | null {
  try {
    const parsed = parseDSLBasic(dsl);
    const declaredName = parsed.name || undefined;
    const agentName = name || declaredName || '';
    let isSupervisor = parsed.kind === 'supervisor';

    let ir: AgentIR | SupervisorIR | null = null;
    try {
      const parseResult = parseAgentBasedABL(dsl);
      if (parseResult.document) {
        const compilationOutput = compileABLtoIR([parseResult.document]);
        const entryName = compilationOutput.entry_agent;
        ir =
          (entryName ? compilationOutput.agents[entryName] : null) ||
          Object.values(compilationOutput.agents)[0] ||
          null;
      }
    } catch (compileError) {
      console.warn(`Warning: Could not compile agent ${agentName}:`, compileError);
    }

    // Detect supervisor behavior from IR even when DSL uses AGENT: instead of SUPERVISOR:
    // Agents with HANDOFF blocks, routing rules, or coordination handoffs are effectively supervisors
    if (!isSupervisor && ir) {
      const hasRouting = !!(ir as SupervisorIR).routing?.rules?.length;
      const hasHandoffs = !!(ir as AgentIR).coordination?.handoffs?.length;
      if (hasRouting || hasHandoffs) {
        isSupervisor = true;
      }
    }

    return {
      id: agentName,
      name: agentName,
      filePath: '',
      type: isSupervisor ? 'supervisor' : 'agent',
      mode: parsed.mode,
      toolCount: parsed.tools.length,
      gatherFieldCount: parsed.gatherFields.length,
      isSupervisor,
      declaredName,
      dsl,
      suggestedTests: generateTestCasesFromParsed(parsed, dsl),
      ir: ir || undefined,
    };
  } catch (error) {
    console.error(`Error building agent details from DSL (${name}):`, error);
    return null;
  }
}

// =============================================================================
// TEST CASE GENERATION
// =============================================================================

function generateTestCasesFromParsed(parsed: ParsedAgent, dsl: string): TestCase[] {
  const tests: TestCase[] = [];
  let testId = 1;

  if (parsed.gatherFields.length > 0) {
    const gatherFields = parsed.gatherFields.join(', ');
    tests.push({
      id: `test-${testId++}`,
      name: 'Happy Path - Complete Flow',
      description: `Provide all required information: ${gatherFields}`,
      category: 'happy_path',
      inputs: [`I need help with ${parsed.goal || 'the task'}`],
      expectations: [{ type: 'action', value: 'complete' }],
    });

    for (const field of parsed.gatherFields) {
      tests.push({
        id: `test-${testId++}`,
        name: `Gather - Missing ${field}`,
        description: `Test behavior when ${field} is not provided`,
        category: 'edge_case',
        inputs: ['Start the process', 'I dont know'],
        expectations: [{ type: 'response_contains', value: field }],
      });
    }
  }

  if (parsed.constraints.length > 0) {
    tests.push({
      id: `test-${testId++}`,
      name: 'Constraint - Violation Test',
      description: 'Test constraint violation handling',
      category: 'constraint',
      inputs: ['Trigger constraint violation'],
      expectations: [{ type: 'action', value: 'block' }],
    });
  }

  for (const target of parsed.handoffs) {
    tests.push({
      id: `test-${testId++}`,
      name: `Handoff - To ${target}`,
      description: `Test handoff to ${target}`,
      category: 'handoff',
      inputs: [`I want to speak to ${target}`],
      expectations: [{ type: 'action', value: 'handoff' }],
    });
  }

  if (dsl.includes('ESCALATE:') || dsl.includes('escalate:')) {
    tests.push({
      id: `test-${testId++}`,
      name: 'Escalation - Human Agent',
      description: 'Test escalation to human agent',
      category: 'handoff',
      inputs: ['I need to speak to a human', 'This is urgent'],
      expectations: [{ type: 'action', value: 'escalate' }],
    });
  }

  if (dsl.includes('ON_ERROR:') || dsl.includes('on_error:')) {
    tests.push({
      id: `test-${testId++}`,
      name: 'Error - Handling Test',
      description: 'Test error handling behavior',
      category: 'error',
      inputs: ['Trigger error scenario'],
      expectations: [{ type: 'trace_event', value: 'error' }],
    });
  }

  return tests;
}
