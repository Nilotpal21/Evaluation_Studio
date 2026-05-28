/**
 * Tool Commands
 *
 * Tool Library CRUD for the active project.
 *
 * URL convention: Studio uses tool **ID** in the URL path for
 * GET, PUT, and DELETE. List uses the project-scoped collection endpoint.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync } from 'fs';
import { apiRequest } from '../lib/api-client.js';
import { getCurrentProjectId, getCurrentProjectSlug } from '../lib/config.js';
import { isAuthenticated } from '../lib/credentials.js';

// =============================================================================
// TYPES
// =============================================================================

interface Tool {
  id: string;
  name: string;
  slug?: string;
  toolType?: string;
  description?: string;
  dslContent?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface ToolListResponse {
  success: boolean;
  data: Tool[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function requireAuth(): void {
  if (!isAuthenticated()) {
    process.stderr.write(chalk.red('Not authenticated. Run: kore-platform-cli login\n'));
    process.exit(1);
  }
}

function requireProject(): string {
  const projectId = getCurrentProjectId();
  if (!projectId) {
    process.stderr.write(
      chalk.red('No active project. Run: kore-platform-cli projects select <slug>\n'),
    );
    process.exit(1);
  }
  return projectId;
}

/**
 * Resolve a tool name to its ID by listing tools.
 */
async function resolveToolId(projectId: string, nameOrId: string): Promise<string> {
  // If it looks like an ID, use directly
  if (nameOrId.includes('-') && nameOrId.length > 20) {
    return nameOrId;
  }

  const result = await apiRequest<ToolListResponse>(`/api/projects/${projectId}/tools`);

  const tool = result.data?.find((t) => t.name === nameOrId || t.id === nameOrId);

  if (!tool) {
    throw new Error(`Tool not found: ${nameOrId}`);
  }

  return tool.id;
}

// =============================================================================
// COMMANDS
// =============================================================================

/**
 * List tools in the active project
 */
async function list(): Promise<void> {
  requireAuth();
  const projectId = requireProject();

  const spinner = ora('Loading tools').start();

  try {
    const result = await apiRequest<ToolListResponse>(`/api/projects/${projectId}/tools`);
    spinner.stop();

    const tools = result.data;
    if (!tools || tools.length === 0) {
      process.stdout.write(chalk.yellow('No tools found.\n'));
      process.stdout.write(
        chalk.gray('Create one with: kore-platform-cli tools create <name> -f <file>\n'),
      );
      return;
    }

    process.stdout.write(chalk.white.bold(`Tools in ${getCurrentProjectSlug()}:\n\n`));
    for (const tool of tools) {
      process.stdout.write(
        `  ${chalk.cyan(tool.name)} ${chalk.gray(`(${tool.id})`)}` +
          (tool.toolType ? chalk.gray(` [${tool.toolType}]`) : '') +
          (tool.description ? chalk.gray(` — ${tool.description}`) : '') +
          '\n',
      );
    }
    process.stdout.write(
      chalk.gray(`\n  ${tools.length} tool(s)`) +
        (result.pagination.hasMore
          ? chalk.gray(
              ` (page ${result.pagination.page} of ${Math.ceil(result.pagination.total / result.pagination.limit)})`,
            )
          : '') +
        '\n',
    );
  } catch (error) {
    spinner.stop();
    process.stderr.write(
      chalk.red(`Failed to list tools: ${error instanceof Error ? error.message : error}\n`),
    );
    process.exit(1);
  }
}

/**
 * Get tool details — resolves name to ID, then fetches.
 */
async function get(name: string): Promise<void> {
  requireAuth();
  const projectId = requireProject();

  const spinner = ora('Loading tool').start();

  try {
    const toolId = await resolveToolId(projectId, name);
    const result = await apiRequest<{ tool: Tool }>(`/api/projects/${projectId}/tools/${toolId}`);

    spinner.stop();

    process.stdout.write(chalk.white.bold(`${result.tool.name}\n`));
    process.stdout.write(chalk.gray(`  ID:   ${result.tool.id}\n`));
    process.stdout.write(chalk.gray(`  Type: ${result.tool.toolType ?? 'unknown'}\n`));
    if (result.tool.description) {
      process.stdout.write(chalk.gray(`  Desc: ${result.tool.description}\n`));
    }

    if (result.tool.dslContent) {
      process.stdout.write(chalk.gray('\n  DSL:\n'));
      process.stdout.write(result.tool.dslContent + '\n');
    } else {
      process.stdout.write(chalk.yellow('\nTool has no DSL content.\n'));
    }
  } catch (error) {
    spinner.stop();
    process.stderr.write(
      chalk.red(`Failed to get tool: ${error instanceof Error ? error.message : error}\n`),
    );
    process.exit(1);
  }
}

/**
 * Create a tool from a .tools.abl file.
 */
async function create(
  name: string,
  options: {
    file?: string;
    type?: string;
    description: string;
    endpoint?: string;
    method?: string;
    runtime?: string;
    code?: string;
    server?: string;
  },
): Promise<void> {
  requireAuth();
  const projectId = requireProject();

  const toolType = options.type ?? 'http';

  // Validate required fields per tool type
  if (toolType === 'http') {
    if (!options.endpoint) {
      process.stderr.write(chalk.red('--endpoint is required for http tools\n'));
      process.exit(1);
    }
    if (!options.method) {
      process.stderr.write(chalk.red('--method is required for http tools\n'));
      process.exit(1);
    }
  } else if (toolType === 'sandbox') {
    if (!options.runtime) {
      process.stderr.write(chalk.red('--runtime is required for sandbox tools\n'));
      process.exit(1);
    }
    if (!options.code) {
      process.stderr.write(chalk.red('--code is required for sandbox tools\n'));
      process.exit(1);
    }
  } else if (toolType === 'mcp') {
    if (!options.server) {
      process.stderr.write(chalk.red('--server is required for mcp tools\n'));
      process.exit(1);
    }
  }

  let dslContent: string | undefined;
  if (options.file) {
    try {
      dslContent = readFileSync(options.file, 'utf-8');
    } catch (err) {
      process.stderr.write(
        chalk.red(`Failed to read file: ${err instanceof Error ? err.message : err}\n`),
      );
      process.exit(1);
    }
  }

  const spinner = ora('Creating tool').start();

  try {
    const body: Record<string, unknown> = {
      name,
      toolType,
      description: options.description,
    };

    // Add type-specific fields
    if (toolType === 'http') {
      body.endpoint = options.endpoint;
      body.method = options.method;
    } else if (toolType === 'sandbox') {
      body.runtime = options.runtime;
      body.code = options.code;
    } else if (toolType === 'mcp') {
      body.server = options.server;
    }

    if (dslContent) {
      body.dslContent = dslContent;
    }

    const result = await apiRequest<{ success: boolean; tool: Tool }>(
      `/api/projects/${projectId}/tools`,
      {
        method: 'POST',
        body,
      },
    );

    spinner.stop();
    process.stdout.write(chalk.green(`✓ Created tool: ${result.tool.name}\n`));
    process.stdout.write(chalk.gray(`  ID:   ${result.tool.id}\n`));
    process.stdout.write(chalk.gray(`  Type: ${result.tool.toolType ?? toolType}\n`));
  } catch (error) {
    spinner.stop();
    process.stderr.write(
      chalk.red(`Failed to create tool: ${error instanceof Error ? error.message : error}\n`),
    );
    process.exit(1);
  }
}

/**
 * Update tool DSL from file — resolves name to ID.
 */
async function update(name: string, options: { file: string }): Promise<void> {
  requireAuth();
  const projectId = requireProject();

  let dslContent: string;
  try {
    dslContent = readFileSync(options.file, 'utf-8');
  } catch (err) {
    process.stderr.write(
      chalk.red(`Failed to read file: ${err instanceof Error ? err.message : err}\n`),
    );
    process.exit(1);
  }

  const spinner = ora('Updating tool').start();

  try {
    const toolId = await resolveToolId(projectId, name);
    await apiRequest<{ tool: Tool }>(`/api/projects/${projectId}/tools/${toolId}`, {
      method: 'PUT',
      body: { dslContent },
    });

    spinner.stop();
    process.stdout.write(chalk.green(`✓ Updated tool: ${name}\n`));
  } catch (error) {
    spinner.stop();
    process.stderr.write(
      chalk.red(`Failed to update tool: ${error instanceof Error ? error.message : error}\n`),
    );
    process.exit(1);
  }
}

/**
 * Delete a tool — resolves name to ID.
 */
async function remove(nameOrId: string, options: { force?: boolean }): Promise<void> {
  requireAuth();
  const projectId = requireProject();

  if (!options.force) {
    process.stdout.write(chalk.yellow(`This will permanently delete tool "${nameOrId}".\n`));
    process.stdout.write(chalk.gray('Use --force to skip this confirmation.\n'));
    process.exit(1);
  }

  const spinner = ora('Deleting tool').start();

  try {
    const toolId = await resolveToolId(projectId, nameOrId);
    await apiRequest<{ deleted: string }>(`/api/projects/${projectId}/tools/${toolId}?force=true`, {
      method: 'DELETE',
    });

    spinner.stop();
    process.stdout.write(chalk.green(`✓ Deleted tool: ${nameOrId}\n`));
  } catch (error) {
    spinner.stop();
    process.stderr.write(
      chalk.red(`Failed to delete tool: ${error instanceof Error ? error.message : error}\n`),
    );
    process.exit(1);
  }
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerToolCommands(program: Command): void {
  const tools = program.command('tools').description('Manage tools in the Tool Library');

  tools
    .command('list')
    .alias('ls')
    .description('List all tools in the active project')
    .action(list);

  tools
    .command('create <name>')
    .description('Create a new tool')
    .requiredOption('-d, --description <text>', 'Tool description (required)')
    .option('-f, --file <path>', 'Path to .tools.abl file')
    .option('-t, --type <type>', 'Tool type (http, sandbox, mcp)', 'http')
    .option('--endpoint <url>', 'HTTP endpoint URL (required for http tools)')
    .option(
      '--method <method>',
      'HTTP method: GET, POST, PUT, PATCH, DELETE (required for http tools)',
    )
    .option(
      '--runtime <runtime>',
      'Sandbox runtime: javascript, python (required for sandbox tools)',
    )
    .option('--code <code>', 'Sandbox code (required for sandbox tools)')
    .option('--server <url>', 'MCP server URL (required for mcp tools)')
    .action(create);

  tools.command('get <name>').description('Get tool details and DSL content').action(get);

  tools
    .command('update <name>')
    .description('Update tool DSL from file')
    .requiredOption('-f, --file <path>', 'Path to .tools.abl file')
    .action(update);

  tools
    .command('delete <name>')
    .alias('rm')
    .description('Delete a tool')
    .option('-f, --force', 'Skip confirmation')
    .action(remove);
}
