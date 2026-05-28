/**
 * MCP Authoring Tools
 *
 * Tools for creating, managing, and compiling ABL agents on the platform.
 * Most tools are REMOTE (require platform auth). kore_validate_agent is LOCAL.
 */

import { readFileSync } from 'fs';
import { validateABLContent } from '../validate/index.js';

export interface AuthoringTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Local authoring tools that don't require platform authentication */
export const LOCAL_AUTHORING_TOOLS = new Set(['kore_validate_agent']);

export const authoringTools: AuthoringTool[] = [
  // =========================================================================
  // REMOTE TOOLS (require platform auth)
  // =========================================================================
  {
    name: 'kore_create_agent',
    description:
      'Create a new agent in a project. Provide ABL DSL content to define the agent behavior.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        name: { type: 'string', description: 'Agent name' },
        dslContent: { type: 'string', description: 'ABL DSL content for the agent' },
      },
      required: ['projectId', 'name', 'dslContent'],
    },
  },
  {
    name: 'kore_list_agents',
    description: 'List all agents in a project. Returns agent names, types, and status.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'kore_get_agent_dsl',
    description: 'Get the ABL DSL source code for an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        agentId: { type: 'string', description: 'Agent ID' },
      },
      required: ['projectId', 'agentId'],
    },
  },
  {
    name: 'kore_update_agent_dsl',
    description: 'Update the ABL DSL content for an existing agent.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        agentId: { type: 'string', description: 'Agent ID' },
        dslContent: { type: 'string', description: 'Updated ABL DSL content' },
      },
      required: ['projectId', 'agentId', 'dslContent'],
    },
  },
  {
    name: 'kore_add_tool',
    description:
      'Add a tool definition to an agent DSL. Appends the tool block to the existing DSL.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        agentId: { type: 'string', description: 'Agent ID' },
        toolName: { type: 'string', description: 'Tool name' },
        toolSpec: {
          type: 'object',
          description:
            'Tool specification: { description, endpoint?, method?, parameters?: Record<string, { type, description, required? }> }',
        },
      },
      required: ['projectId', 'agentId', 'toolName', 'toolSpec'],
    },
  },
  {
    name: 'kore_add_flow_step',
    description: 'Add a flow step to a scripted agent. Appends the step to the flow.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        agentId: { type: 'string', description: 'Agent ID' },
        stepName: { type: 'string', description: 'Step name' },
        stepSpec: {
          type: 'object',
          description:
            'Step specification: { collect?: string[], prompt?: string, respond?: string, transitions?: Record<string, string> }',
        },
      },
      required: ['projectId', 'agentId', 'stepName', 'stepSpec'],
    },
  },
  {
    name: 'kore_add_constraint',
    description: 'Add a constraint to an agent. Constraints enforce rules during agent execution.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        agentId: { type: 'string', description: 'Agent ID' },
        constraint: { type: 'string', description: 'Constraint text (natural language or CEL)' },
        severity: {
          type: 'string',
          description: 'Constraint severity: error, warning, or info',
          enum: ['error', 'warning', 'info'],
        },
      },
      required: ['projectId', 'agentId', 'constraint'],
    },
  },
  {
    name: 'kore_add_handoff',
    description:
      'Add a handoff target to an agent. Handoffs allow agents to transfer conversations.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        agentId: { type: 'string', description: 'Agent ID' },
        targetAgent: { type: 'string', description: 'Target agent name for handoff' },
        condition: {
          type: 'string',
          description: 'Optional condition for when handoff should trigger',
        },
      },
      required: ['projectId', 'agentId', 'targetAgent'],
    },
  },
  {
    name: 'kore_compile_agent',
    description:
      'Compile an agent DSL to IR (Intermediate Representation). Returns compilation result with any errors or warnings.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        agentId: { type: 'string', description: 'Agent ID' },
      },
      required: ['projectId', 'agentId'],
    },
  },

  // =========================================================================
  // LOCAL TOOLS (no auth required)
  // =========================================================================
  {
    name: 'kore_validate_agent',
    description:
      'Validate ABL DSL content or a file locally without requiring platform auth. Returns syntax errors and warnings.',
    inputSchema: {
      type: 'object',
      properties: {
        dslContent: {
          type: 'string',
          description: 'ABL DSL content to validate (provide this OR path, not both)',
        },
        path: {
          type: 'string',
          description:
            'Path to a .agent.abl file to validate (provide this OR dslContent, not both)',
        },
      },
    },
  },
];

/** Handle an authoring tool call */
export async function handleAuthoringTool(
  name: string,
  args: Record<string, unknown>,
  apiUrl: string,
  headers: Record<string, string>,
): Promise<unknown> {
  switch (name) {
    // =========================================================================
    // LOCAL: kore_validate_agent
    // =========================================================================
    case 'kore_validate_agent': {
      const { dslContent, path } = args as { dslContent?: string; path?: string };

      if (!dslContent && !path) {
        throw new Error('Provide either dslContent or path');
      }

      const content = dslContent ?? readFileSync(path!, 'utf-8');
      const fileName = path ?? 'inline.agent.abl';
      const result = validateABLContent(content, fileName);

      return {
        valid: result.errors.length === 0,
        errors: result.errors,
        warnings: result.warnings,
      };
    }

    // =========================================================================
    // REMOTE: Agent CRUD
    // =========================================================================
    case 'kore_create_agent': {
      const {
        projectId,
        name: agentName,
        dslContent,
      } = args as {
        projectId: string;
        name: string;
        dslContent: string;
      };
      const response = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/agents`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: agentName, dslContent }),
        },
      );
      if (!response.ok) throw new Error(`Failed to create agent: ${response.statusText}`);
      return response.json();
    }

    case 'kore_list_agents': {
      const { projectId } = args as { projectId: string };
      const response = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/agents`,
        { headers },
      );
      if (!response.ok) throw new Error(`Failed to list agents: ${response.statusText}`);
      return response.json();
    }

    case 'kore_get_agent_dsl': {
      const { projectId, agentId } = args as { projectId: string; agentId: string };
      const response = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}`,
        { headers },
      );
      if (!response.ok) throw new Error(`Failed to get agent DSL: ${response.statusText}`);
      return response.json();
    }

    case 'kore_update_agent_dsl': {
      const { projectId, agentId, dslContent } = args as {
        projectId: string;
        agentId: string;
        dslContent: string;
      };
      const response = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({ dslContent }),
        },
      );
      if (!response.ok) throw new Error(`Failed to update agent DSL: ${response.statusText}`);
      return response.json();
    }

    case 'kore_add_tool': {
      const { projectId, agentId, toolName, toolSpec } = args as {
        projectId: string;
        agentId: string;
        toolName: string;
        toolSpec: Record<string, unknown>;
      };
      const response = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/tools`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: toolName, ...toolSpec }),
        },
      );
      if (!response.ok) throw new Error(`Failed to add tool: ${response.statusText}`);
      return response.json();
    }

    case 'kore_add_flow_step': {
      const { projectId, agentId, stepName, stepSpec } = args as {
        projectId: string;
        agentId: string;
        stepName: string;
        stepSpec: Record<string, unknown>;
      };
      const response = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/flow-steps`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: stepName, ...stepSpec }),
        },
      );
      if (!response.ok) throw new Error(`Failed to add flow step: ${response.statusText}`);
      return response.json();
    }

    case 'kore_add_constraint': {
      const { projectId, agentId, constraint, severity } = args as {
        projectId: string;
        agentId: string;
        constraint: string;
        severity?: string;
      };
      const response = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/constraints`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ constraint, severity: severity ?? 'error' }),
        },
      );
      if (!response.ok) throw new Error(`Failed to add constraint: ${response.statusText}`);
      return response.json();
    }

    case 'kore_add_handoff': {
      const { projectId, agentId, targetAgent, condition } = args as {
        projectId: string;
        agentId: string;
        targetAgent: string;
        condition?: string;
      };
      const response = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/handoffs`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ targetAgent, condition }),
        },
      );
      if (!response.ok) throw new Error(`Failed to add handoff: ${response.statusText}`);
      return response.json();
    }

    case 'kore_compile_agent': {
      const { projectId, agentId } = args as { projectId: string; agentId: string };
      const response = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/compile`,
        {
          method: 'POST',
          headers,
        },
      );
      if (!response.ok) throw new Error(`Failed to compile agent: ${response.statusText}`);
      return response.json();
    }

    default:
      throw new Error(`Unknown authoring tool: ${name}`);
  }
}
