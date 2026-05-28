/**
 * CLI Doctor Command
 *
 * kore doctor --project <id>
 *
 * Calls the post-import validator API and displays a formatted health report.
 * Shows missing env vars, connectors needing credentials, MCP servers needing auth,
 * and guardrail providers not configured.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { apiRequest } from '../lib/api-client.js';
import { getConfig } from '../lib/config.js';

interface PostImportReport {
  status: 'ready' | 'imported_with_warnings' | 'action_required';
  provisioning_required: {
    env_vars: string[];
    connectors_needing_credentials: string[];
    mcp_servers_needing_auth: string[];
  };
  warnings: string[];
  layer_summary: Record<string, { imported: number; skipped: number }>;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Run health check on a project (post-import validation)')
    .option('--project <id>', 'Project ID (uses current project if omitted)')
    .action(async (opts) => {
      const config = getConfig();
      const projectId = opts.project ?? config.currentProjectId;

      if (!projectId) {
        console.error('No project specified. Use --project <id> or set a current project.');
        process.exit(1);
      }

      console.log(`Running health check on project ${projectId}...\n`);

      const report = await apiRequest<PostImportReport>(`/api/projects/${projectId}/import/doctor`);

      // Status header
      const statusColors: Record<string, (text: string) => string> = {
        ready: chalk.green,
        imported_with_warnings: chalk.yellow,
        action_required: chalk.red,
      };
      const colorFn = statusColors[report.status] ?? chalk.white;
      const statusLabel = report.status.replace(/_/g, ' ').toUpperCase();
      console.log(chalk.white.bold('Status: ') + colorFn(statusLabel));

      // Layer summary
      const layerEntries = Object.entries(report.layer_summary);
      if (layerEntries.length > 0) {
        console.log(chalk.white.bold('\nLayers:'));
        for (const [layer, counts] of layerEntries) {
          const parts: string[] = [];
          if (counts.imported > 0) parts.push(chalk.green(`${counts.imported} imported`));
          if (counts.skipped > 0) parts.push(chalk.gray(`${counts.skipped} skipped`));
          console.log(`  ${layer}: ${parts.join(', ')}`);
        }
      }

      // Provisioning required
      const prov = report.provisioning_required;
      const hasProvisioning =
        prov.env_vars.length > 0 ||
        prov.connectors_needing_credentials.length > 0 ||
        prov.mcp_servers_needing_auth.length > 0;

      if (hasProvisioning) {
        console.log(chalk.white.bold('\nProvisioning Required:'));

        if (prov.env_vars.length > 0) {
          console.log(chalk.red(`\n  Missing Environment Variables (${prov.env_vars.length}):`));
          for (const v of prov.env_vars) {
            console.log(chalk.red(`    - ${v}`));
          }
        }

        if (prov.connectors_needing_credentials.length > 0) {
          console.log(
            chalk.red(
              `\n  Connectors Needing Credentials (${prov.connectors_needing_credentials.length}):`,
            ),
          );
          for (const c of prov.connectors_needing_credentials) {
            console.log(chalk.red(`    - ${c}`));
          }
        }

        if (prov.mcp_servers_needing_auth.length > 0) {
          console.log(
            chalk.red(`\n  MCP Servers Needing Auth (${prov.mcp_servers_needing_auth.length}):`),
          );
          for (const s of prov.mcp_servers_needing_auth) {
            console.log(chalk.red(`    - ${s}`));
          }
        }
      }

      // Warnings
      if (report.warnings.length > 0) {
        console.log(chalk.white.bold(`\nWarnings (${report.warnings.length}):`));
        for (const w of report.warnings) {
          console.log(chalk.yellow(`  - ${w}`));
        }
      }

      // Final summary
      console.log('');
      if (report.status === 'ready') {
        console.log(chalk.green('Project is fully provisioned and ready to use.'));
      } else if (report.status === 'action_required') {
        console.log(
          chalk.red(
            'Action required: Provision the missing resources above before the project can run.',
          ),
        );
        process.exit(1);
      } else {
        console.log(chalk.yellow('Project imported with warnings. Review the items above.'));
      }
    });
}
