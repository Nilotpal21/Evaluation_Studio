/**
 * Agent Commands
 *
 * Agent CRUD, DSL management, compilation, and testing commands.
 *
 * URL convention: Studio uses agent **name** in the URL path for
 * GET, DSL update, and compile. DELETE uses actual agent ID.
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

interface Agent {
  id: string;
  name: string;
  agentPath?: string;
  dslContent?: string;
  agentType?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface ChatResponse {
  sessionId: string;
  response: string;
  traceEvents?: Array<{ type: string; data?: unknown }>;
}

// =============================================================================
// HELPERS
// =============================================================================

function requireAuth(): void {
  if (!isAuthenticated()) {
    console.error(chalk.red('Not authenticated. Run: kore-platform-cli login'));
    process.exit(1);
  }
}

function requireProject(): string {
  const projectId = getCurrentProjectId();
  if (!projectId) {
    console.error(chalk.red('No active project. Run: kore-platform-cli projects select <slug>'));
    process.exit(1);
  }
  return projectId;
}

/**
 * Resolve an agent name to its ID by listing agents.
 * Only needed for DELETE (which requires the actual ID).
 */
async function resolveAgentId(projectId: string, nameOrId: string): Promise<string> {
  // If it looks like an ID, use directly
  if (nameOrId.includes('-') && nameOrId.length > 20) {
    return nameOrId;
  }

  const result = await apiRequest<{ agents: Agent[] }>(`/api/projects/${projectId}/agents`);

  const agent = result.agents?.find((a) => a.name === nameOrId || a.id === nameOrId);

  if (!agent) {
    throw new Error(`Agent not found: ${nameOrId}`);
  }

  return agent.id;
}

// =============================================================================
// COMMANDS
// =============================================================================

/**
 * List agents in the active project
 */
async function list(): Promise<void> {
  requireAuth();
  const projectId = requireProject();

  const spinner = ora('Loading agents').start();

  try {
    const result = await apiRequest<{ agents: Agent[] }>(`/api/projects/${projectId}/agents`);
    spinner.stop();

    if (!result.agents || result.agents.length === 0) {
      console.log(chalk.yellow('No agents found.'));
      console.log(chalk.gray('Create one with: kore-platform-cli agents create <name> -f <file>'));
      return;
    }

    console.log(chalk.white.bold(`Agents in ${getCurrentProjectSlug()}:\n`));
    for (const agent of result.agents) {
      console.log(
        `  ${chalk.cyan(agent.name)} ${chalk.gray(`(${agent.id})`)}` +
          (agent.agentType ? chalk.gray(` [${agent.agentType}]`) : ''),
      );
    }
    console.log(chalk.gray(`\n  ${result.agents.length} agent(s)`));
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to list agents: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Create an agent.
 *
 * Studio POST /agents expects { name } and derives the canonical agent path.
 * If DSL is provided we follow up with PUT /agents/{name}/dsl.
 */
async function create(name: string, options: { file?: string; dsl?: string }): Promise<void> {
  requireAuth();
  const projectId = requireProject();

  let dslContent: string | undefined;
  if (options.file) {
    try {
      dslContent = readFileSync(options.file, 'utf-8');
    } catch (err) {
      console.error(chalk.red(`Failed to read file: ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }
  } else if (options.dsl) {
    dslContent = options.dsl;
  }

  const spinner = ora('Creating agent').start();

  try {
    // Step 1: Create agent record. The server derives the canonical agent path.
    const agent = await apiRequest<Agent>(`/api/projects/${projectId}/agents`, {
      method: 'POST',
      body: { name },
    });

    // Step 2: Upload DSL if provided
    if (dslContent) {
      await apiRequest<{ success: boolean }>(
        `/api/projects/${projectId}/agents/${encodeURIComponent(name)}/dsl`,
        {
          method: 'PUT',
          body: { dslContent },
        },
      );
    }

    spinner.stop();
    console.log(chalk.green(`✓ Created agent: ${agent.name}`));
    console.log(chalk.gray(`  ID: ${agent.id}`));
    if (dslContent) {
      console.log(chalk.gray(`  DSL uploaded`));
    }
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to create agent: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Get agent DSL — uses agent name in URL (not ID).
 */
async function get(name: string): Promise<void> {
  requireAuth();
  const projectId = requireProject();

  const spinner = ora('Loading agent').start();

  try {
    const result = await apiRequest<{ agent: Agent }>(
      `/api/projects/${projectId}/agents/${encodeURIComponent(name)}`,
    );

    spinner.stop();

    if (result.agent.dslContent) {
      console.log(result.agent.dslContent);
    } else {
      console.log(chalk.yellow('Agent has no DSL content.'));
    }
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to get agent: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Update agent DSL from file — uses agent name in URL.
 */
async function update(name: string, options: { file: string }): Promise<void> {
  requireAuth();
  const projectId = requireProject();

  let dslContent: string;
  try {
    dslContent = readFileSync(options.file, 'utf-8');
  } catch (err) {
    console.error(chalk.red(`Failed to read file: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }

  const spinner = ora('Updating agent').start();

  try {
    await apiRequest<{ success: boolean }>(
      `/api/projects/${projectId}/agents/${encodeURIComponent(name)}/dsl`,
      {
        method: 'PUT',
        body: { dslContent },
      },
    );

    spinner.stop();
    console.log(chalk.green(`✓ Updated agent: ${name}`));
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to update agent: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Compile an agent — uses agent name in URL.
 */
async function compile(name: string): Promise<void> {
  requireAuth();
  const projectId = requireProject();

  const spinner = ora('Compiling agent').start();

  try {
    const result = await apiRequest<{ success: boolean; errors?: string[]; warnings?: string[] }>(
      `/api/projects/${projectId}/agents/${encodeURIComponent(name)}/compile`,
      { method: 'POST' },
    );

    spinner.stop();

    if (result.success) {
      console.log(chalk.green('✓ Compilation successful'));
    } else {
      console.log(chalk.red('✗ Compilation failed'));
    }

    if (result.errors && result.errors.length > 0) {
      console.log(chalk.red('\nErrors:'));
      for (const err of result.errors) {
        console.log(chalk.red(`  • ${err}`));
      }
    }

    if (result.warnings && result.warnings.length > 0) {
      console.log(chalk.yellow('\nWarnings:'));
      for (const warn of result.warnings) {
        console.log(chalk.yellow(`  • ${warn}`));
      }
    }
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to compile agent: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Test an agent by sending a message — uses POST /api/v1/chat/agent.
 * Studio proxies /api/v1/chat/* to Runtime.
 */
async function test(
  name: string,
  options: { message?: string; sessionId?: string },
): Promise<void> {
  requireAuth();
  const projectId = requireProject();

  if (!options.message) {
    console.error(chalk.red('--message is required. Example: agents test my_agent -m "Hello"'));
    process.exit(1);
  }

  const spinner = ora('Sending message').start();

  try {
    const body: Record<string, string> = {
      projectId,
      agentName: name,
      message: options.message,
    };
    if (options.sessionId) {
      body.sessionId = options.sessionId;
    }

    const result = await apiRequest<ChatResponse>('/api/v1/chat/agent', {
      method: 'POST',
      body,
    });

    spinner.stop();

    console.log(chalk.white.bold('Response:'));
    console.log(result.response);
    console.log();
    console.log(chalk.gray(`Session: ${result.sessionId}`));

    if (result.traceEvents && result.traceEvents.length > 0) {
      console.log(chalk.gray(`Trace events: ${result.traceEvents.length}`));
    }
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to test agent: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Fetch traces for a session.
 */
async function traces(sessionId: string): Promise<void> {
  requireAuth();
  const projectId = requireProject();

  const spinner = ora('Loading traces').start();

  try {
    const result = await apiRequest<{ traces: Array<{ type: string; data?: unknown }> }>(
      `/api/projects/${projectId}/sessions/${sessionId}/traces`,
    );

    spinner.stop();

    if (!result.traces || result.traces.length === 0) {
      console.log(chalk.yellow('No traces found.'));
      return;
    }

    console.log(chalk.white.bold(`Traces for session ${sessionId}:\n`));
    for (const trace of result.traces) {
      console.log(`  ${chalk.cyan(trace.type)} ${chalk.gray(JSON.stringify(trace.data ?? {}))}`);
    }
    console.log(chalk.gray(`\n  ${result.traces.length} trace(s)`));
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to load traces: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Delete an agent — uses actual agent ID (resolved from name).
 */
async function remove(nameOrId: string, options: { force?: boolean }): Promise<void> {
  requireAuth();
  const projectId = requireProject();

  if (!options.force) {
    console.log(chalk.yellow(`This will permanently delete agent "${nameOrId}".`));
    console.log(chalk.gray('Use --force to skip this confirmation.'));
    process.exit(1);
  }

  const spinner = ora('Deleting agent').start();

  try {
    const agentId = await resolveAgentId(projectId, nameOrId);
    await apiRequest<{ success: boolean }>(`/api/projects/${projectId}/agents/${agentId}`, {
      method: 'DELETE',
    });

    spinner.stop();
    console.log(chalk.green(`✓ Deleted agent: ${nameOrId}`));
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to delete agent: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerAgentCommands(program: Command): void {
  const agents = program.command('agents').description('Manage agents');

  agents
    .command('list')
    .alias('ls')
    .description('List all agents in the active project')
    .action(list);

  agents
    .command('create <name>')
    .description('Create a new agent')
    .option('-f, --file <path>', 'Path to .agent.abl file')
    .option('--dsl <content>', 'Inline DSL content')
    .action(create);

  agents.command('get <name>').description('Get agent DSL content').action(get);

  agents
    .command('update <name>')
    .description('Update agent DSL from file')
    .requiredOption('-f, --file <path>', 'Path to .agent.abl file')
    .action(update);

  agents.command('compile <name>').description('Compile agent DSL to IR').action(compile);

  agents
    .command('test <name>')
    .description('Send a test message to an agent')
    .requiredOption('-m, --message <text>', 'Message to send')
    .option('-s, --session-id <id>', 'Existing session ID (creates new if omitted)')
    .action(test);

  agents
    .command('traces <sessionId>')
    .description('Fetch trace events for a session')
    .action(traces);

  agents
    .command('delete <name>')
    .alias('rm')
    .description('Delete an agent')
    .option('-f, --force', 'Skip confirmation')
    .action(remove);
}
