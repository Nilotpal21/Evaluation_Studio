/**
 * CLI Model Management Commands + MCP Tool Definitions
 *
 * Provides `kore models list|add|test|set-default|remove` CLI commands
 * and corresponding MCP tools for managing tenant LLM models.
 */

import type { Command } from 'commander';
import { getApiUrl } from '../lib/config.js';
import { getToken } from '../lib/credentials.js';

// =============================================================================
// MCP TOOL DEFINITIONS
// =============================================================================

export interface ModelTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const modelTools: ModelTool[] = [
  {
    name: 'kore_list_models',
    description:
      'List all configured LLM models for the tenant. Returns model names, providers, and default status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kore_add_model',
    description: 'Add a new LLM model configuration for the tenant.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'LLM provider (e.g., anthropic, openai, google)' },
        model: { type: 'string', description: 'Model identifier (e.g., claude-sonnet-4-20250514)' },
        apiKey: { type: 'string', description: 'API key for the provider' },
        displayName: { type: 'string', description: 'Optional display name' },
      },
      required: ['provider', 'model', 'apiKey'],
    },
  },
  {
    name: 'kore_test_model',
    description:
      'Test connectivity to a configured LLM model. Sends a simple ping and verifies the model responds.',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Model ID to test' },
      },
      required: ['modelId'],
    },
  },
  {
    name: 'kore_set_default_model',
    description: 'Set a model as the default for a project or tenant.',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Model ID to set as default' },
        projectId: { type: 'string', description: 'Optional project ID (tenant-wide if omitted)' },
      },
      required: ['modelId'],
    },
  },
];

/** Handle MCP model tool calls */
export async function handleModelTool(
  name: string,
  args: Record<string, unknown>,
  apiUrl: string,
  headers: Record<string, string>,
): Promise<unknown> {
  switch (name) {
    case 'kore_list_models': {
      const response = await fetch(`${apiUrl}/api/tenant-models`, { headers });
      if (!response.ok) throw new Error(`Failed to list models: ${response.statusText}`);
      return response.json();
    }

    case 'kore_add_model': {
      const { provider, model, apiKey, displayName } = args as {
        provider: string;
        model: string;
        apiKey: string;
        displayName?: string;
      };
      const response = await fetch(`${apiUrl}/api/tenant-models`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ provider, model, apiKey, displayName }),
      });
      if (!response.ok) throw new Error(`Failed to add model: ${response.statusText}`);
      return response.json();
    }

    case 'kore_test_model': {
      const { modelId } = args as { modelId: string };
      const response = await fetch(
        `${apiUrl}/api/tenant-models/${encodeURIComponent(modelId)}/test`,
        { method: 'POST', headers },
      );
      if (!response.ok) throw new Error(`Failed to test model: ${response.statusText}`);
      return response.json();
    }

    case 'kore_set_default_model': {
      const { modelId, projectId } = args as { modelId: string; projectId?: string };
      const body: Record<string, unknown> = { isDefault: true };
      if (projectId) body.projectId = projectId;

      const response = await fetch(`${apiUrl}/api/tenant-models/${encodeURIComponent(modelId)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Failed to set default model: ${response.statusText}`);
      return response.json();
    }

    default:
      throw new Error(`Unknown model tool: ${name}`);
  }
}

// =============================================================================
// CLI COMMANDS
// =============================================================================

function getHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) throw new Error('Not authenticated. Run: kore-platform-cli login');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

export function registerModelCommands(program: Command): void {
  const models = program.command('models').description('Manage LLM model configurations');

  models
    .command('list')
    .description('List all configured LLM models')
    .action(async () => {
      const apiUrl = getApiUrl();
      const headers = getHeaders();
      const response = await fetch(`${apiUrl}/api/tenant-models`, { headers });
      if (!response.ok) {
        console.error(`Failed to list models: ${response.statusText}`);
        process.exit(1);
      }
      const data = (await response.json()) as { models?: unknown[] };
      console.log(JSON.stringify(data.models ?? data, null, 2));
    });

  models
    .command('add')
    .description('Add a new LLM model')
    .requiredOption('--provider <provider>', 'LLM provider (anthropic, openai, google)')
    .requiredOption('--model <model>', 'Model identifier')
    .requiredOption('--api-key <key>', 'API key')
    .option('--display-name <name>', 'Display name')
    .action(async (opts) => {
      const apiUrl = getApiUrl();
      const headers = getHeaders();
      const response = await fetch(`${apiUrl}/api/tenant-models`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider: opts.provider,
          model: opts.model,
          apiKey: opts.apiKey,
          displayName: opts.displayName,
        }),
      });
      if (!response.ok) {
        console.error(`Failed to add model: ${response.statusText}`);
        process.exit(1);
      }
      const data = await response.json();
      console.log('Model added:', JSON.stringify(data, null, 2));
    });

  models
    .command('test <modelId>')
    .description('Test connectivity to a model')
    .action(async (modelId: string) => {
      const apiUrl = getApiUrl();
      const headers = getHeaders();
      const response = await fetch(
        `${apiUrl}/api/tenant-models/${encodeURIComponent(modelId)}/test`,
        { method: 'POST', headers },
      );
      if (!response.ok) {
        console.error(`Test failed: ${response.statusText}`);
        process.exit(1);
      }
      const data = await response.json();
      console.log('Test result:', JSON.stringify(data, null, 2));
    });

  models
    .command('set-default <modelId>')
    .description('Set a model as the default')
    .option('--project <projectId>', 'Project ID (tenant-wide if omitted)')
    .action(async (modelId: string, opts) => {
      const apiUrl = getApiUrl();
      const headers = getHeaders();
      const body: Record<string, unknown> = { isDefault: true };
      if (opts.project) body.projectId = opts.project;

      const response = await fetch(`${apiUrl}/api/tenant-models/${encodeURIComponent(modelId)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        console.error(`Failed to set default: ${response.statusText}`);
        process.exit(1);
      }
      console.log('Default model set successfully');
    });

  models
    .command('remove <modelId>')
    .description('Remove a model configuration')
    .action(async (modelId: string) => {
      const apiUrl = getApiUrl();
      const headers = getHeaders();
      const response = await fetch(`${apiUrl}/api/tenant-models/${encodeURIComponent(modelId)}`, {
        method: 'DELETE',
        headers,
      });
      if (!response.ok) {
        console.error(`Failed to remove model: ${response.statusText}`);
        process.exit(1);
      }
      console.log('Model removed successfully');
    });
}
