/**
 * Agent Registry Adapter
 *
 * Implements the ConstructAgentRegistry interface for looking up
 * agent IRs by name during delegate/handoff operations.
 */

import type {
  ConstructAgentRegistry,
  AgentIR,
  CompilationOutput,
  Environment,
} from '@abl/compiler';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';

// =============================================================================
// TYPES
// =============================================================================

interface RegisteredAgent {
  dsl: string;
  ir: AgentIR | null;
  compiledAt: Date;
}

// =============================================================================
// AGENT REGISTRY ADAPTER
// =============================================================================

export class TestAgentRegistry implements ConstructAgentRegistry {
  private registry: Map<string, RegisteredAgent> = new Map();

  /**
   * Register an agent from ABL source
   */
  registerFromDSL(agentName: string, dsl: string): AgentIR | null {
    const parseResult = parseAgentBasedABL(dsl);
    let ir: AgentIR | null = null;

    if (parseResult.document) {
      try {
        const compilationOutput = compileABLtoIR([parseResult.document]);
        const entryName = compilationOutput.entry_agent;
        ir =
          (entryName ? compilationOutput.agents[entryName] : null) ||
          Object.values(compilationOutput.agents)[0] ||
          null;
      } catch (error) {
        console.error(`[AgentRegistry] Failed to compile agent ${agentName}:`, error);
      }
    }

    this.registry.set(agentName, {
      dsl,
      ir,
      compiledAt: new Date(),
    });

    console.log(`[AgentRegistry] Registered agent: ${agentName}`);
    return ir;
  }

  /**
   * Register an agent from pre-compiled IR
   */
  registerFromIR(agentName: string, ir: AgentIR, dsl: string = ''): void {
    this.registry.set(agentName, {
      dsl,
      ir,
      compiledAt: new Date(),
    });
    console.log(`[AgentRegistry] Registered agent from IR: ${agentName}`);
  }

  /**
   * Register all agents from a compilation output
   */
  registerFromCompilationOutput(output: CompilationOutput): void {
    // Register all agents (supervisors are now agents with routing configured)
    for (const [name, ir] of Object.entries(output.agents)) {
      this.registry.set(name, {
        dsl: '',
        ir,
        compiledAt: new Date(),
      });
      console.log(`[AgentRegistry] Registered agent: ${name}`);
    }
  }

  /**
   * Get agent IR by name
   */
  getAgentIR(agentName: string, _environment: Environment): AgentIR | null {
    const registered = this.registry.get(agentName);
    return registered?.ir || null;
  }

  /**
   * List available agents
   */
  listAgents(_environment: Environment): string[] {
    return Array.from(this.registry.keys());
  }

  /**
   * Check if an agent exists
   */
  hasAgent(agentName: string, _environment: Environment): boolean {
    return this.registry.has(agentName);
  }

  /**
   * Get agent ABL source (if available)
   */
  getAgentDSL(agentName: string): string | null {
    const registered = this.registry.get(agentName);
    return registered?.dsl || null;
  }

  /**
   * Unregister an agent
   */
  unregister(agentName: string): boolean {
    return this.registry.delete(agentName);
  }

  /**
   * Clear all registered agents
   */
  clear(): void {
    this.registry.clear();
  }

  /**
   * Get registration info for an agent
   */
  getRegistrationInfo(agentName: string): { compiledAt: Date } | null {
    const registered = this.registry.get(agentName);
    if (!registered) return null;
    return { compiledAt: registered.compiledAt };
  }
}
