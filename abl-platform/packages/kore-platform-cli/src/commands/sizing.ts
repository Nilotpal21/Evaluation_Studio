/**
 * CLI Sizing Calculator Commands
 *
 * Provides `kore-platform-cli sizing calculate|helm|questionnaire` commands
 * for generating production K8s topology recommendations.
 */

import type { Command } from 'commander';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { registerBenchmarkCommands } from './sizing-benchmark.js';
import { registerReportCommands } from './sizing-report.js';

export function registerSizingCommands(program: Command): void {
  const sizing = program.command('sizing').description('Production topology sizing calculator');

  // Register benchmark subcommands (benchmark, benchmark-service, calibration-merge)
  registerBenchmarkCommands(sizing);

  // Register report subcommands (report, load-report)
  registerReportCommands(sizing);

  sizing
    .command('questionnaire')
    .description('Generate an empty questionnaire template')
    .requiredOption('--output <path>', 'Output file path for the questionnaire JSON')
    .action(async (opts: { output: string }) => {
      const template = {
        deployment: {
          cloudProvider: 'aws',
          regionCount: 1,
          haRequirement: 'standard',
          networkIsolation: 'shared-vpc',
          compliance: [],
        },
        llm: {
          hostingModel: 'external-api',
          selfHostedModels: [],
          concurrentRequests: 50,
          contextWindow: 'medium',
          embeddingModel: 'bge-m3',
        },
        agents: {
          agentCount: 10,
          concurrentConversations: 100,
          avgConversationLength: 10,
          messagesPerDay: 1000,
          toolCallsPerConversation: 3,
          multiAgentUsage: 0,
        },
        knowledgeBase: {
          totalDocuments: 1000,
          avgDocumentSize: 'small',
          documentTypes: ['pdf'],
          ingestionFrequency: 'daily',
          connectorTypes: ['file-upload'],
          kbPerProject: 1,
          vectorSearchQueriesPerDay: 500,
        },
        workflows: {
          activeWorkflows: 10,
          executionsPerDay: 100,
          avgStepsPerWorkflow: 5,
          triggers: ['manual'],
          externalApiCallsPerWorkflow: 2,
        },
        channels: {
          activeChannels: ['web-widget'],
          voiceVideoUsage: 0,
          inboundWebhooksPerDay: 0,
          outboundWebhooksPerDay: 0,
        },
        observability: {
          adminUsers: 5,
          traceRetention: '30d',
          metricsRetention: '90d',
          auditLogRetention: '1y',
          monitoringStack: 'platform-builtin',
        },
        retention: {
          conversationRetention: '90d',
          documentRetention: 'until-deleted',
          attachmentRetention: '1y',
          encryptionAtRest: 'platform-aes256',
          backupFrequency: 'daily',
          drRtpRpo: 'rpo-24h-rto-4h',
        },
      };

      await writeFile(opts.output, JSON.stringify(template, null, 2));
      console.log(`Questionnaire template written to ${opts.output}`);
    });

  sizing
    .command('calculate')
    .description('Calculate topology from questionnaire')
    .requiredOption('--input <path>', 'Input questionnaire JSON file')
    .requiredOption('--output <path>', 'Output topology JSON file')
    .option('--calibration <path>', 'CalibrationProfile JSON file (measured per-pod capacity)')
    .action(async (opts: { input: string; output: string; calibration?: string }) => {
      // Dynamic import to avoid loading at CLI startup
      const { QuestionnaireSchema, CalibrationProfileSchema, calculateTopology } =
        await import('@agent-platform/sizing-calculator');

      const raw = await readFile(opts.input, 'utf-8');
      const parsed = JSON.parse(raw);

      const result = QuestionnaireSchema.safeParse(parsed);
      if (!result.success) {
        console.error('Invalid questionnaire:');
        for (const issue of result.error.issues) {
          console.error(`  ${issue.path.join('.')}: ${issue.message}`);
        }
        process.exit(1);
      }

      let calibration;
      if (opts.calibration) {
        const calibrationRaw = await readFile(opts.calibration, 'utf-8');
        const calibrationParsed = JSON.parse(calibrationRaw);
        const calibrationResult = CalibrationProfileSchema.safeParse(calibrationParsed);
        if (!calibrationResult.success) {
          console.error('Invalid calibration profile:');
          for (const issue of calibrationResult.error.issues) {
            console.error(`  ${issue.path.join('.')}: ${issue.message}`);
          }
          process.exit(1);
        }
        calibration = calibrationResult.data;
        console.log(`Using calibration profile: ${opts.calibration}`);
        console.log(`  Environment: ${calibration.environment}`);
        console.log(`  Services calibrated: ${Object.keys(calibration.services).length}`);
        console.log(`  Data stores calibrated: ${Object.keys(calibration.dataStores).length}`);
      }

      const topology = calculateTopology(result.data, calibration);
      await writeFile(opts.output, JSON.stringify(topology, null, 2));
      console.log(`Topology written to ${opts.output}`);
      console.log(`  Tier: ${topology.tier}`);
      console.log(`  Services: ${topology.services.length}`);
      console.log(`  Data stores: ${topology.dataStores.length}`);
      console.log(`  Node pools: ${topology.nodePools.length}`);
      console.log(`  Total nodes: ${topology.totalNodes.min}-${topology.totalNodes.max}`);
      console.log(`  Monthly storage growth: ${topology.monthlyStorageGrowthGB} GB`);
      if (calibration) {
        console.log(`  Mode: CALIBRATED (measured per-pod capacity)`);
      } else {
        console.log(`  Mode: BASELINE (hardcoded estimates)`);
      }
    });

  sizing
    .command('helm')
    .description('Generate Helm values from topology')
    .requiredOption('--input <path>', 'Input topology JSON file')
    .requiredOption('--output-dir <path>', 'Output directory for Helm values files')
    .action(async (opts: { input: string; outputDir: string }) => {
      const { generateHelmValues } = await import('@agent-platform/sizing-calculator');

      const raw = await readFile(opts.input, 'utf-8');
      const topology = JSON.parse(raw);

      const values = generateHelmValues(topology);

      await mkdir(opts.outputDir, { recursive: true });

      for (const [filename, content] of Object.entries(values)) {
        const filepath = join(opts.outputDir, filename);
        await writeFile(filepath, String(content));
        console.log(`  Written: ${filepath}`);
      }

      console.log(`\nHelm values generated in ${opts.outputDir}`);
    });
}
