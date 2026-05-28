/**
 * Project Commands
 *
 * Project management commands.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  listProjects,
  createProject as apiCreateProject,
  deleteProject as apiDeleteProject,
  type Project,
} from '../lib/api-client.js';
import {
  setCurrentProject,
  getCurrentProjectId,
  getCurrentProjectSlug,
  clearCurrentProject,
} from '../lib/config.js';
import { isAuthenticated } from '../lib/credentials.js';

// =============================================================================
// HELPERS
// =============================================================================

function requireAuth(): void {
  if (!isAuthenticated()) {
    console.error(chalk.red('Not authenticated. Run: kore-platform-cli login'));
    process.exit(1);
  }
}

function formatTable(projects: Project[]): void {
  const currentId = getCurrentProjectId();

  // Calculate column widths
  const nameWidth = Math.max(12, ...projects.map((p) => p.name.length)) + 2;
  const slugWidth = Math.max(12, ...projects.map((p) => p.slug.length)) + 2;
  const agentsWidth = 8;

  // Header
  console.log(
    chalk.gray(
      '┌' +
        '─'.repeat(nameWidth) +
        '┬' +
        '─'.repeat(slugWidth) +
        '┬' +
        '─'.repeat(agentsWidth) +
        '┐',
    ),
  );
  console.log(
    chalk.gray('│') +
      chalk.white(' Name'.padEnd(nameWidth)) +
      chalk.gray('│') +
      chalk.white(' Slug'.padEnd(slugWidth)) +
      chalk.gray('│') +
      chalk.white(' Agents'.padEnd(agentsWidth)) +
      chalk.gray('│'),
  );
  console.log(
    chalk.gray(
      '├' +
        '─'.repeat(nameWidth) +
        '┼' +
        '─'.repeat(slugWidth) +
        '┼' +
        '─'.repeat(agentsWidth) +
        '┤',
    ),
  );

  // Rows
  for (const project of projects) {
    const isCurrent = project.id === currentId;
    const marker = isCurrent ? chalk.green('* ') : '  ';
    const name = (marker + project.name).padEnd(nameWidth + (isCurrent ? 10 : 0)); // Account for color codes
    const slug = project.slug.padEnd(slugWidth);
    const agents = String(project.agentCount || 0).padStart(agentsWidth - 2);

    console.log(
      chalk.gray('│') +
        (isCurrent
          ? chalk.green(project.name.padEnd(nameWidth - 2)) + chalk.green('* ')
          : ' ' + name) +
        chalk.gray('│') +
        ' ' +
        chalk.cyan(slug) +
        chalk.gray('│') +
        ' ' +
        chalk.white(agents) +
        ' ' +
        chalk.gray('│'),
    );
  }

  // Footer
  console.log(
    chalk.gray(
      '└' +
        '─'.repeat(nameWidth) +
        '┴' +
        '─'.repeat(slugWidth) +
        '┴' +
        '─'.repeat(agentsWidth) +
        '┘',
    ),
  );
}

// =============================================================================
// COMMANDS
// =============================================================================

/**
 * List projects
 */
async function list(): Promise<void> {
  requireAuth();

  const spinner = ora('Loading projects').start();

  try {
    const { projects } = await listProjects();
    spinner.stop();

    if (projects.length === 0) {
      console.log(chalk.yellow('No projects found.'));
      console.log(chalk.gray('Create one with: kore-platform-cli projects create <name>'));
      return;
    }

    formatTable(projects);

    const currentSlug = getCurrentProjectSlug();
    if (currentSlug) {
      console.log(chalk.gray(`\nActive project: ${currentSlug}`));
    }
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to list projects: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Create a project
 */
async function create(name: string, options: { description?: string }): Promise<void> {
  requireAuth();

  const spinner = ora('Creating project').start();

  try {
    const project = await apiCreateProject({
      name,
      description: options.description,
    });

    spinner.stop();

    console.log(chalk.green(`✓ Created project: ${project.slug}`));
    console.log(chalk.gray(`  ID: ${project.id}`));

    // Auto-select if no current project
    if (!getCurrentProjectId()) {
      setCurrentProject(project.id, project.slug);
      console.log(chalk.gray(`  Set as active project`));
    }
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to create project: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Select a project
 */
async function select(slugOrId: string): Promise<void> {
  requireAuth();

  const spinner = ora('Finding project').start();

  try {
    const { projects } = await listProjects();
    const project = projects.find((p) => p.slug === slugOrId || p.id === slugOrId);

    spinner.stop();

    if (!project) {
      console.error(chalk.red(`Project not found: ${slugOrId}`));
      process.exit(1);
    }

    setCurrentProject(project.id, project.slug);
    console.log(chalk.green(`✓ Active project: ${project.slug}`));
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to select project: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Delete a project
 */
async function remove(slugOrId: string, options: { force?: boolean }): Promise<void> {
  requireAuth();

  // Confirmation
  if (!options.force) {
    console.log(
      chalk.yellow(`This will permanently delete the project "${slugOrId}" and all its data.`),
    );
    console.log(chalk.gray('Use --force to skip this confirmation.'));
    process.exit(1);
  }

  const spinner = ora('Finding project').start();

  try {
    const { projects } = await listProjects();
    const project = projects.find((p) => p.slug === slugOrId || p.id === slugOrId);

    if (!project) {
      spinner.stop();
      console.error(chalk.red(`Project not found: ${slugOrId}`));
      process.exit(1);
    }

    spinner.text = 'Deleting project';
    await apiDeleteProject(project.id);

    spinner.stop();

    // Clear if it was the current project
    if (getCurrentProjectId() === project.id) {
      clearCurrentProject();
    }

    console.log(chalk.green(`✓ Deleted project: ${project.slug}`));
  } catch (error) {
    spinner.stop();
    console.error(
      chalk.red(`Failed to delete project: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

/**
 * Show current project
 */
function current(): void {
  const slug = getCurrentProjectSlug();
  const id = getCurrentProjectId();

  if (!slug || !id) {
    console.log(chalk.yellow('No active project'));
    console.log(chalk.gray('Select one with: kore-platform-cli projects select <slug>'));
    return;
  }

  console.log(chalk.white('Active project: ') + chalk.cyan(slug));
  console.log(chalk.white('ID: ') + chalk.gray(id));
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerProjectCommands(program: Command): void {
  const projects = program.command('projects').description('Manage projects');

  projects.command('list').alias('ls').description('List all projects').action(list);

  projects
    .command('create <name>')
    .description('Create a new project')
    .option('-d, --description <text>', 'Project description')
    .action(create);

  projects.command('select <slug>').description('Set active project').action(select);

  projects
    .command('delete <slug>')
    .alias('rm')
    .description('Delete a project')
    .option('-f, --force', 'Skip confirmation')
    .action(remove);

  projects.command('current').description('Show active project').action(current);
}
