/**
 * CLI Benchmark Commands
 *
 * Registers `sizing benchmark`, `sizing benchmark-service`, and
 * `sizing calibration-merge` subcommands on the sizing Command.
 */

import type { Command } from 'commander';
import { readFile, writeFile } from 'fs/promises';
import { loadCloudEnv } from './sizing-report.js';

export function registerBenchmarkCommands(sizing: Command): void {
  // -------------------------------------------------------------------------
  // sizing benchmark — full pipeline
  // -------------------------------------------------------------------------
  sizing
    .command('benchmark')
    .description('Run saturation benchmarks and produce a CalibrationProfile')
    .requiredOption('--tier <tier>', 'Deployment tier: S, M, L, or XL')
    .requiredOption('--output-calibration <path>', 'Output path for the CalibrationProfile JSON')
    .option('--services <list>', 'Comma-separated services or @categories', '@all')
    .option('--namespace <ns>', 'Kubernetes namespace (env: NAMESPACE)', 'abl')
    .option('--dry-run', 'Validate preflight only, do not run tests', false)
    .option('--headroom <percent>', 'Headroom percentage to subtract from measured capacity', '15')
    .option('--max-duration <seconds>', 'Max duration per k6 test in seconds', '300')
    .option('--output-report <path>', 'Output path for the human-readable report')
    .option('--output-pdf <path>', 'Output path for PDF report')
    .option('--scenario-weights <json>', 'JSON string of scenario weights')
    .option('--skip-per-scenario', 'Skip per-scenario breakdown', false)
    .option('--prometheus-url <url>', 'Prometheus/Coroot URL for metrics collection')
    .action(
      async (opts: {
        tier: string;
        outputCalibration: string;
        services: string;
        namespace: string;
        dryRun: boolean;
        headroom: string;
        maxDuration: string;
        outputReport?: string;
        outputPdf?: string;
        scenarioWeights?: string;
        skipPerScenario: boolean;
        prometheusUrl?: string;
      }) => {
        // Auto-load benchmarks/config/cloud.env (real env vars take precedence)
        await loadCloudEnv();
        // Override namespace from cloud.env if user didn't pass --namespace explicitly
        if (opts.namespace === 'abl' && process.env.NAMESPACE) {
          opts.namespace = process.env.NAMESPACE;
        }
        // Dynamic imports to keep CLI startup fast
        const { resolveServices, SERVICE_REGISTRY } =
          await import('./benchmark/service-registry.js');
        const { runPreflight } = await import('./benchmark/preflight.js');
        const { scaleDown, restoreReplicas, getPodResources } =
          await import('./benchmark/kubectl-ops.js');
        const { runK6Saturation } = await import('./benchmark/k6-runner.js');
        const { detectSaturation } = await import('./benchmark/saturation-detector.js');
        const { assembleServiceCapacity, assembleProfile } =
          await import('./benchmark/profile-assembler.js');

        const tier = opts.tier as 'S' | 'M' | 'L' | 'XL';
        if (!['S', 'M', 'L', 'XL'].includes(tier)) {
          console.error(`Invalid tier: ${opts.tier}. Must be S, M, L, or XL.`);
          process.exit(1);
        }

        const serviceTokens = opts.services.split(',').map((s) => s.trim());
        let services: string[];
        try {
          services = resolveServices(serviceTokens);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }

        console.log(`Benchmark pipeline: ${services.length} services, tier=${tier}`);

        // Build deployment name list
        const deploymentNames = services.map((s) => SERVICE_REGISTRY[s].deploymentName);

        // Preflight
        const preflight = await runPreflight({
          namespace: opts.namespace,
          services,
          deploymentNames,
          requireCoroot: false,
          corootUrl: opts.prometheusUrl,
        });

        for (const w of preflight.warnings) {
          console.warn(`WARNING: ${w}`);
        }

        if (!preflight.passed) {
          console.error('Preflight failed:');
          for (const e of preflight.errors) {
            console.error(`  - ${e}`);
          }
          process.exit(1);
        }

        if (opts.dryRun) {
          console.log('Preflight passed. Dry-run mode — skipping benchmarks.');
          console.log('Original replicas:', JSON.stringify(preflight.originalReplicas, null, 2));
          return;
        }

        const serviceCapacities: Record<
          string,
          import('@agent-platform/sizing-calculator').ServiceCapacity
        > = {};

        for (const serviceName of services) {
          const entry = SERVICE_REGISTRY[serviceName];
          if (!entry.k6Script) {
            console.log(`Skipping ${serviceName} — no k6 script available`);
            continue;
          }

          console.log(`\nBenchmarking: ${serviceName}`);

          try {
            // Scale down to 1 pod
            await scaleDown(entry.deploymentName, opts.namespace);

            // Get pod resources
            const podResources = await getPodResources(entry.deploymentName, opts.namespace);

            // Run k6 saturation test
            const summaryPath = `${opts.outputCalibration}.${serviceName}.k6.json`;
            const k6Result = await runK6Saturation({
              scriptPath: entry.k6Script,
              summaryOutputPath: summaryPath,
              targetUrl: `http://${entry.deploymentName}.${opts.namespace}.svc.cluster.local`,
              maxDurationSeconds: parseInt(opts.maxDuration, 10),
              benchmarksDir: 'benchmarks',
            });

            // Detect saturation
            const saturation = detectSaturation({
              errorRate: k6Result.errorRate,
              baselineP95Ms: k6Result.latency.p95Ms * 0.5, // approximate baseline
              currentP95Ms: k6Result.latency.p95Ms,
              cpuPeakPercent: null,
              wsUpgradeRefused: 0,
              wsTimeoutSpike: false,
              rps: k6Result.rps,
              maxVUs: k6Result.maxVUs,
            });

            // Assemble service capacity
            const capacity = assembleServiceCapacity({
              serviceName,
              k6Result,
              saturation,
              podResources,
              testedUrl: `http://${entry.deploymentName}.${opts.namespace}.svc.cluster.local`,
              testedViaIngress: false,
              baselineP95Ms: k6Result.latency.p95Ms * 0.5,
            });

            // Apply headroom
            const headroom = parseInt(opts.headroom, 10) / 100;
            capacity.saturation.maxRpsPerPod = Math.floor(
              capacity.saturation.maxRpsPerPod * (1 - headroom),
            );
            capacity.saturation.maxConcurrentPerPod = Math.floor(
              capacity.saturation.maxConcurrentPerPod * (1 - headroom),
            );

            serviceCapacities[entry.configKey] = capacity;
            console.log(
              `  ${serviceName}: ${capacity.saturation.maxRpsPerPod} RPS/pod, trigger=${saturation.trigger}`,
            );
          } catch (err) {
            console.error(
              `  Error benchmarking ${serviceName}: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            // Restore original replicas
            const original = preflight.originalReplicas[serviceName] ?? 1;
            try {
              await restoreReplicas(entry.deploymentName, original, opts.namespace);
            } catch (restoreErr) {
              console.error(
                `  Failed to restore replicas for ${serviceName}: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`,
              );
            }
          }
        }

        // Assemble profile
        const profile = assembleProfile({
          tier,
          environment: `benchmark-${opts.namespace}`,
          services: serviceCapacities,
        });

        await writeFile(opts.outputCalibration, JSON.stringify(profile, null, 2));
        console.log(`\nCalibration profile written to ${opts.outputCalibration}`);
        console.log(`  Services measured: ${Object.keys(profile.services).length}`);
      },
    );

  // -------------------------------------------------------------------------
  // sizing benchmark-service — single service benchmark
  // -------------------------------------------------------------------------
  sizing
    .command('benchmark-service')
    .description('Run saturation benchmark for a single service')
    .requiredOption('--service <name>', 'Service name (e.g., runtime, search-ai)')
    .requiredOption('--tier <tier>', 'Deployment tier: S, M, L, or XL')
    .option('--namespace <ns>', 'Kubernetes namespace (env: NAMESPACE)', 'abl')
    .option('--max-duration <seconds>', 'Max duration for k6 test in seconds', '300')
    .option('--headroom <percent>', 'Headroom percentage', '15')
    .option('--output <path>', 'Output path for single-service result JSON')
    .action(
      async (opts: {
        service: string;
        tier: string;
        namespace: string;
        maxDuration: string;
        headroom: string;
        output?: string;
      }) => {
        // Auto-load benchmarks/config/cloud.env (real env vars take precedence)
        await loadCloudEnv();
        // Override namespace from cloud.env if user didn't pass --namespace explicitly
        if (opts.namespace === 'abl' && process.env.NAMESPACE) {
          opts.namespace = process.env.NAMESPACE;
        }
        const { SERVICE_REGISTRY } = await import('./benchmark/service-registry.js');
        const { scaleDown, restoreReplicas, getPodResources } =
          await import('./benchmark/kubectl-ops.js');
        const { runK6Saturation } = await import('./benchmark/k6-runner.js');
        const { detectSaturation } = await import('./benchmark/saturation-detector.js');
        const { assembleServiceCapacity } = await import('./benchmark/profile-assembler.js');

        const entry = SERVICE_REGISTRY[opts.service];
        if (!entry) {
          console.error(`Unknown service: ${opts.service}`);
          console.error(`Known services: ${Object.keys(SERVICE_REGISTRY).join(', ')}`);
          process.exit(1);
        }

        if (!entry.k6Script) {
          console.error(`Service "${opts.service}" has no k6 saturation script`);
          process.exit(1);
        }

        const tier = opts.tier as 'S' | 'M' | 'L' | 'XL';
        if (!['S', 'M', 'L', 'XL'].includes(tier)) {
          console.error(`Invalid tier: ${opts.tier}. Must be S, M, L, or XL.`);
          process.exit(1);
        }

        console.log(`Benchmarking single service: ${opts.service} (tier=${tier})`);

        try {
          await scaleDown(entry.deploymentName, opts.namespace);

          const podResources = await getPodResources(entry.deploymentName, opts.namespace);

          const summaryPath = opts.output
            ? `${opts.output}.k6.json`
            : `benchmark-${opts.service}.k6.json`;

          const k6Result = await runK6Saturation({
            scriptPath: entry.k6Script,
            summaryOutputPath: summaryPath,
            targetUrl: `http://${entry.deploymentName}.${opts.namespace}.svc.cluster.local`,
            maxDurationSeconds: parseInt(opts.maxDuration, 10),
            benchmarksDir: 'benchmarks',
          });

          const saturation = detectSaturation({
            errorRate: k6Result.errorRate,
            baselineP95Ms: k6Result.latency.p95Ms * 0.5,
            currentP95Ms: k6Result.latency.p95Ms,
            cpuPeakPercent: null,
            wsUpgradeRefused: 0,
            wsTimeoutSpike: false,
            rps: k6Result.rps,
            maxVUs: k6Result.maxVUs,
          });

          const capacity = assembleServiceCapacity({
            serviceName: opts.service,
            k6Result,
            saturation,
            podResources,
            testedUrl: `http://${entry.deploymentName}.${opts.namespace}.svc.cluster.local`,
            testedViaIngress: false,
            baselineP95Ms: k6Result.latency.p95Ms * 0.5,
          });

          const headroom = parseInt(opts.headroom, 10) / 100;
          capacity.saturation.maxRpsPerPod = Math.floor(
            capacity.saturation.maxRpsPerPod * (1 - headroom),
          );
          capacity.saturation.maxConcurrentPerPod = Math.floor(
            capacity.saturation.maxConcurrentPerPod * (1 - headroom),
          );

          const output = JSON.stringify({ service: opts.service, tier, capacity }, null, 2);

          if (opts.output) {
            await writeFile(opts.output, output);
            console.log(`Result written to ${opts.output}`);
          } else {
            console.log(output);
          }
        } finally {
          try {
            await restoreReplicas(entry.deploymentName, 1, opts.namespace);
          } catch {
            // Best effort restore
          }
        }
      },
    );

  // -------------------------------------------------------------------------
  // sizing calibration-merge — merge multiple profiles
  // -------------------------------------------------------------------------
  sizing
    .command('calibration-merge')
    .description('Merge multiple CalibrationProfile files')
    .requiredOption(
      '--inputs <paths>',
      'Comma-separated list of CalibrationProfile JSON file paths',
    )
    .requiredOption('--output <path>', 'Output path for merged CalibrationProfile JSON')
    .action(async (opts: { inputs: string; output: string }) => {
      const { CalibrationProfileSchema } = await import('@agent-platform/sizing-calculator');
      const { mergeProfiles } = await import('./benchmark/profile-assembler.js');

      const paths = opts.inputs.split(',').map((p) => p.trim());
      const profiles = [];

      for (const path of paths) {
        const raw = await readFile(path, 'utf-8');
        const parsed = JSON.parse(raw);
        const result = CalibrationProfileSchema.safeParse(parsed);
        if (!result.success) {
          console.error(`Invalid profile at ${path}:`);
          for (const issue of result.error.issues) {
            console.error(`  ${issue.path.join('.')}: ${issue.message}`);
          }
          process.exit(1);
        }
        profiles.push(result.data);
      }

      try {
        const merged = mergeProfiles(profiles);
        await writeFile(opts.output, JSON.stringify(merged, null, 2));
        console.log(`Merged ${profiles.length} profiles into ${opts.output}`);
        console.log(`  Services: ${Object.keys(merged.services).length}`);
        console.log(`  Data stores: ${Object.keys(merged.dataStores).length}`);
      } catch (err) {
        console.error(`Merge failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // Shared test command infrastructure
  // -------------------------------------------------------------------------

  type TestTypeArg = 'service' | 'integration' | 'saturation';

  interface TestCommandOpts {
    tier: string;
    services: string;
    cloud: boolean;
    outputDir: string;
    compare?: string;
    last?: number;
    format: string;
    namespace: string;
    skipInfra: boolean;
    skipReport: boolean;
    scenarioWeights?: string;
    vus?: string;
    duration?: string;
  }

  const TEST_TYPE_LABELS: Record<TestTypeArg, string> = {
    service: 'Service Load Test',
    integration: 'Integration E2E Test',
    saturation: 'Saturation Test',
  };

  async function runTestCommand(testType: TestTypeArg, opts: TestCommandOpts): Promise<void> {
    await loadCloudEnv();
    // Override namespace from cloud.env if user didn't pass --namespace explicitly
    if (opts.namespace === 'abl' && process.env.NAMESPACE) {
      opts.namespace = process.env.NAMESPACE;
    }

    const { resolveTestScripts, listAvailableScripts, runTestSuite, preAuthenticate } =
      await import('./benchmark/test-runner.js');
    const { collectInfraMetrics } = await import('./benchmark/infra-collector.js');
    const { startMetricsSampler } = await import('./benchmark/kubectl-metrics.js');
    const { SERVICE_REGISTRY } = await import('./benchmark/service-registry.js');
    const {
      registerHandlebarsHelpers,
      buildLoadTestReportContext,
      fetchCloudResults,
      loadTemplate,
      findRepoRoot,
      generatePdf,
    } = await import('./sizing-report.js');

    const { mkdir: mkdirFn, writeFile: writeFn, readFile: readFn } = await import('fs/promises');
    const { join, resolve } = await import('path');

    // Parse services
    const serviceTokens = opts.services
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // Resolve scripts
    const scripts = resolveTestScripts(serviceTokens, testType);
    if (scripts.length === 0) {
      console.error(`No ${testType} test scripts found for: ${opts.services}`);
      const available = listAvailableScripts(testType);
      console.error(`Available: ${available.join(', ')}`);
      process.exit(1);
    }

    const repoRoot = await findRepoRoot();
    const benchmarksDir = join(repoRoot, 'benchmarks');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputDir =
      opts.outputDir || join(benchmarksDir, 'results', `${testType}-${opts.tier}-${timestamp}`);

    await mkdirFn(outputDir, { recursive: true });

    const typeLabel = TEST_TYPE_LABELS[testType];
    console.log(`\n=== ${typeLabel} Suite ===`);
    console.log(`  Tier:       ${opts.tier}`);
    console.log(`  Services:   ${opts.services}`);
    console.log(`  Scripts:    ${scripts.length}`);
    console.log(`  Cloud:      ${opts.cloud}`);
    console.log(`  Output:     ${outputDir}`);
    console.log('');

    // Pass scenario weights to k6 scripts via env var
    if (opts.scenarioWeights) {
      process.env.SCENARIO_WEIGHTS = opts.scenarioWeights;
    }

    // Pass VU count to k6 scripts via MAX_VUS env var.
    // Priority: --vus CLI flag > tier profile > script defaults
    if (opts.vus) {
      process.env.MAX_VUS = opts.vus;
      process.stdout.write(`  VUs:        ${opts.vus} (from --vus flag)\n`);
    } else {
      // Load tier profile VUs as default
      try {
        const tierProfilesRaw = await readFn(
          join(benchmarksDir, 'config', 'tier-profiles.json'),
          'utf-8',
        );
        const tierProfiles = JSON.parse(tierProfilesRaw) as Record<
          string,
          Record<string, { vus?: number; duration?: string }>
        >;
        const tierConfig = tierProfiles[opts.tier];
        if (tierConfig) {
          const testTypeKey =
            testType === 'saturation'
              ? 'system'
              : testType === 'service'
                ? 'perService'
                : 'integration';
          const vuCount = tierConfig[testTypeKey]?.vus;
          if (vuCount) {
            process.env.MAX_VUS = String(vuCount);
            process.stdout.write(
              `  VUs:        ${vuCount} (from tier ${opts.tier} ${testTypeKey})\n`,
            );
          }
        }
      } catch {
        // tier-profiles.json not found — use script defaults
      }
    }

    // Pass duration override for saturation tests
    if (opts.duration) {
      process.env.DURATION_MINUTES = opts.duration;
      process.stdout.write(`  Duration:   ${opts.duration}m (from --duration flag)\n`);
    }

    // Step 1: Pre-authenticate once to avoid per-script rate limiting
    await preAuthenticate();

    // Start background metrics sampler before running tests (30s interval)
    const sampler = !opts.skipInfra ? startMetricsSampler(opts.namespace, 30_000) : undefined;

    // Step 2: Run k6 tests
    const suiteResult = await runTestSuite(scripts, {
      benchmarksDir,
      outputDir,
      cloud: opts.cloud,
      healthCheck: false,
    });

    // Stop the sampler now that tests are done
    if (sampler) sampler.stop();

    // Step 3: Collect infra metrics (unless skipped)
    let infraMetricsPath: string | null = null;
    if (!opts.skipInfra) {
      const allServiceNames = new Set<string>();
      for (const script of scripts) {
        if (script.services && script.services.length > 0) {
          for (const svc of script.services) allServiceNames.add(svc);
        } else {
          allServiceNames.add(script.serviceName);
        }
      }

      // Always include data stores — reports need their CPU/memory usage
      for (const name of [
        'mongodb',
        'redis',
        'clickhouse',
        'opensearch',
        'qdrant',
        'neo4j',
        'restate',
      ]) {
        allServiceNames.add(name);
      }

      const infraServices = Array.from(allServiceNames)
        .filter((name) => SERVICE_REGISTRY[name])
        .map((name) => ({
          name,
          deploymentName: SERVICE_REGISTRY[name].deploymentName,
          category: SERVICE_REGISTRY[name].category,
        }));

      infraMetricsPath = await collectInfraMetrics({
        services: infraServices,
        namespace: opts.namespace,
        fromTimestamp: suiteResult.startTime,
        toTimestamp: suiteResult.endTime,
        outputPath: join(outputDir, 'infra-metrics.json'),
        sampler,
      });
    }

    // Step 3: Generate report (unless skipped)
    if (!opts.skipReport) {
      process.stdout.write('\n--- Report Generation ---\n');
      registerHandlebarsHelpers();

      let context: Record<string, unknown>;

      if (opts.cloud) {
        // Cloud mode: fetch metrics from k6 Cloud API
        const token = process.env.K6_CLOUD_TOKEN ?? '';
        const projectId = process.env.K6_CLOUD_PROJECT_ID ?? '';
        if (!token || !projectId) {
          process.stderr.write(
            '  Skipping cloud report — K6_CLOUD_TOKEN or K6_CLOUD_PROJECT_ID not set.\n',
          );
          context = { services: {}, timestamp: new Date().toISOString() };
        } else {
          const serviceFilter = scripts.map((s) => s.serviceName.replace(/^sat-/, ''));
          const last = parseInt(String(opts.last ?? '1'), 10) || 1;
          context = await fetchCloudResults(projectId, token, last, {
            services: serviceFilter,
            testType,
          });
          const svcCount = Object.keys(context.services as Record<string, unknown>).length;
          process.stdout.write(`  Fetched ${svcCount} service result(s) from k6 Cloud.\n`);
        }
      } else {
        // Local mode: build context from k6 JSON summaries on disk
        context = await buildLoadTestReportContext(
          resolve(outputDir),
          opts.compare ? resolve(opts.compare) : undefined,
        );
      }

      context.tier = opts.tier;
      const durationSec = Math.round((suiteResult.endTime - suiteResult.startTime) / 1000);
      const durationMin = Math.round(durationSec / 60);
      context.duration =
        durationMin > 0 ? `${durationMin}m ${durationSec % 60}s` : `${durationSec}s`;

      // Enrich with timing, tier config, and scenario weights
      context.startTime = new Date(suiteResult.startTime).toISOString();
      context.endTime = new Date(suiteResult.endTime).toISOString();

      // Load tier profile for VU/parallelism/duration config
      try {
        const tierProfilesRaw = await readFn(
          join(benchmarksDir, 'config', 'tier-profiles.json'),
          'utf-8',
        );
        const tierProfiles = JSON.parse(tierProfilesRaw) as Record<string, Record<string, unknown>>;
        const tierConfig = tierProfiles[opts.tier];
        if (tierConfig) {
          context.tierConfig = tierConfig;
        }
      } catch {
        // tier-profiles.json not found — skip
      }

      // Load scenario weights for the tested services
      try {
        const weightsRaw = await readFn(
          join(benchmarksDir, 'config', 'scenario-weights.json'),
          'utf-8',
        );
        const allWeights = JSON.parse(weightsRaw) as Record<string, Record<string, number>>;
        const scenarioWeightsMap: Record<string, Record<string, number>> = {};
        for (const script of scripts) {
          const cleanName = script.serviceName.replace(/^sat-/, '');
          if (allWeights[cleanName]) {
            scenarioWeightsMap[cleanName] = allWeights[cleanName];
          }
        }
        if (Object.keys(scenarioWeightsMap).length > 0) {
          context.scenarioWeights = scenarioWeightsMap;
        }
      } catch {
        // scenario-weights.json not found — skip (not critical)
      }

      if (infraMetricsPath) {
        const infraRaw = await readFn(infraMetricsPath, 'utf-8');
        const infraFile = JSON.parse(infraRaw);

        if (infraFile.services && typeof infraFile.services === 'object') {
          const services = context.services as Record<string, Record<string, unknown>>;
          const serviceKeys = Object.keys(services);
          let enrichedCount = 0;
          const deployments: Array<Record<string, unknown>> = [];

          // Match infra service name to report service name (handles suffixed names)
          const findSvcData = (infraName: string): Record<string, unknown> | undefined => {
            if (services[infraName]) return services[infraName];
            const match = serviceKeys.find(
              (k) =>
                k === infraName ||
                k.startsWith(infraName + '-') ||
                k.startsWith('sat-' + infraName),
            );
            return match ? services[match] : undefined;
          };

          for (const [serviceName, infraData] of Object.entries(infraFile.services)) {
            const svcData = findSvcData(serviceName);
            const infra = infraData as {
              infra?: unknown;
              dataStore?: unknown;
              deployment?: {
                replicas?: number;
                readyReplicas?: number;
                cpuRequest?: string | null;
                memoryRequest?: string | null;
                cpuLimit?: string | null;
                memoryLimit?: string | null;
                kind?: string;
              };
            };

            if (svcData) {
              if (infra.infra) {
                svcData.infra = infra.infra;
                enrichedCount++;
              }
              if (infra.dataStore) {
                svcData.dataStoreInfra = infra.dataStore;
                enrichedCount++;
              }
            } else if (infra.dataStore) {
              services[serviceName] = {
                totalRequests: 0,
                errorRate: 0,
                throughput: '0',
                latency: { minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 },
                dataStoreInfra: infra.dataStore,
              };
              enrichedCount++;
            }

            // Collect deployment info for the infrastructure overview
            if (infra.deployment) {
              deployments.push({
                name: serviceName,
                kind: infra.deployment.kind ?? 'Deployment',
                replicas: infra.deployment.replicas ?? 0,
                readyReplicas: infra.deployment.readyReplicas ?? 0,
                cpuRequest: infra.deployment.cpuRequest ?? 'N/A',
                memoryRequest: infra.deployment.memoryRequest ?? 'N/A',
                cpuLimit: infra.deployment.cpuLimit ?? 'N/A',
                memoryLimit: infra.deployment.memoryLimit ?? 'N/A',
              });
            }
          }

          context.hasInfraMetrics = enrichedCount > 0 || deployments.length > 0;
          context.infraMetricsSource = infraFile.source ?? 'unknown';
          context.corootProject = infraFile.project ?? '';

          if (deployments.length > 0) {
            context.deployments = deployments;
            context.hasDeployments = true;
          }

          process.stdout.write(`  Infra metrics merged: ${enrichedCount} service(s)\n`);
          if (deployments.length > 0) {
            process.stdout.write(`  Deployment info: ${deployments.length} service(s)\n`);
          }

          // Build per-pod capacity recommendations
          const recommendations: Array<Record<string, unknown>> = [];
          const deploymentsByName: Record<string, Record<string, unknown>> = {};
          for (const d of deployments) {
            deploymentsByName[d.name as string] = d;
          }

          for (const [svcName, svcResult] of Object.entries(services)) {
            const svc = svcResult as {
              throughput?: string;
              vus?: number;
              latency?: { p95Ms?: number; p99Ms?: number; avgMs?: number };
              errorRate?: number;
            };
            const throughput = parseFloat(svc.throughput ?? '0');
            const vus = svc.vus ?? 0;
            if (throughput <= 0) continue;

            // Find matching deployment (fuzzy match)
            const cleanName = svcName
              .replace(/^sat-/, '')
              .replace(/-saturation$/, '')
              .replace(/-service$/, '');
            const depInfo = deploymentsByName[cleanName] ?? deploymentsByName[svcName];
            const replicas = (depInfo?.replicas as number) ?? 0;

            if (replicas > 0) {
              const perPodRps = throughput / replicas;
              const perPodVUs = Math.round(vus / replicas);
              const p95 = svc.latency?.p95Ms ?? 0;
              const p99 = svc.latency?.p99Ms ?? 0;
              const errorRate = svc.errorRate ?? 0;

              recommendations.push({
                service: cleanName,
                replicas,
                totalRps: throughput,
                perPodRps: parseFloat(perPodRps.toFixed(1)),
                totalVUs: vus,
                perPodVUs,
                p95Ms: parseFloat(p95.toFixed(1)),
                p99Ms: parseFloat(p99.toFixed(1)),
                errorRate: parseFloat((errorRate * 100).toFixed(2)),
                healthy: errorRate < 0.01 && p95 < 2000,
              });
            }
          }

          if (recommendations.length > 0) {
            context.recommendations = recommendations;
            context.hasRecommendations = true;
          }
        }

        // Pass through service-to-datastore latency breakdown
        if (
          infraFile.serviceLatency &&
          Array.isArray(infraFile.serviceLatency) &&
          infraFile.serviceLatency.length > 0
        ) {
          context.serviceLatency = infraFile.serviceLatency;
          context.hasServiceLatency = true;
        }
      }

      // Generate insights and recommendations based on all collected data
      const { generateInsights } = await import('./sizing-report.js');
      generateInsights(context);

      const template = await loadTemplate('load-test');
      const markdown = template(context);
      const reportName = `${testType}-report`;
      const mdPath = join(outputDir, `${reportName}.md`);
      await writeFn(mdPath, markdown);
      process.stdout.write(`  Report written to ${mdPath}\n`);

      if (opts.format === 'pdf') {
        const cssPath = join(repoRoot, 'benchmarks', 'report', 'styles', 'customer-report.css');
        const pdfPath = join(outputDir, `${reportName}.pdf`);
        const ok = await generatePdf(mdPath, pdfPath, cssPath);
        if (ok) {
          process.stdout.write(`  PDF written to ${pdfPath}\n`);
        }
      }
    }

    console.log(`\n=== ${typeLabel} Complete ===`);
    console.log(`  Results:    ${outputDir}`);
    console.log(`  Passed:     ${suiteResult.passed}/${suiteResult.total}`);
    if (suiteResult.failed > 0) {
      console.log(`  Failed:     ${suiteResult.failed}`);
    }

    if (suiteResult.failed > 0) {
      process.exit(1);
    }
  }

  // -------------------------------------------------------------------------
  // Smoke test runner — 1 VU, 1 iteration, no thresholds
  // -------------------------------------------------------------------------

  interface SmokeCommandOpts {
    services: string;
    namespace: string;
  }

  async function runSmokeCommand(testType: TestTypeArg, opts: SmokeCommandOpts): Promise<void> {
    await loadCloudEnv();
    // Override namespace from cloud.env if user didn't pass --namespace explicitly
    if (opts.namespace === 'abl' && process.env.NAMESPACE) {
      opts.namespace = process.env.NAMESPACE;
    }

    const { resolveTestScripts, listAvailableScripts, runTestSuite, preAuthenticate } =
      await import('./benchmark/test-runner.js');
    const { findRepoRoot } = await import('./sizing-report.js');
    const { mkdir: mkdirFn } = await import('fs/promises');
    const { join } = await import('path');

    const serviceTokens = opts.services
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const scripts = resolveTestScripts(serviceTokens, testType);
    if (scripts.length === 0) {
      console.error(`No ${testType} scripts found for: ${opts.services}`);
      const available = listAvailableScripts(testType);
      console.error(`Available: ${available.join(', ')}`);
      process.exit(1);
    }

    const repoRoot = await findRepoRoot();
    const benchmarksDir = join(repoRoot, 'benchmarks');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputDir = join(benchmarksDir, 'results', `smoke-${testType}-${timestamp}`);
    await mkdirFn(outputDir, { recursive: true });

    const typeLabel = TEST_TYPE_LABELS[testType];
    console.log(`\n=== ${typeLabel} Smoke Test ===`);
    console.log(`  Mode:       smoke (1 VU, 1 iteration, no thresholds)`);
    console.log(`  Services:   ${opts.services}`);
    console.log(`  Scripts:    ${scripts.length}`);
    console.log('');

    // Pre-authenticate once to avoid per-script rate limiting
    await preAuthenticate();

    const suiteResult = await runTestSuite(scripts, {
      benchmarksDir,
      outputDir,
      cloud: false,
      healthCheck: false,
      smoke: true,
    });

    console.log(`\n=== ${typeLabel} Smoke Complete ===`);
    console.log(`  Results:    ${outputDir}`);
    console.log(`  Passed:     ${suiteResult.passed}/${suiteResult.total}`);
    if (suiteResult.failed > 0) {
      console.log(`  Failed:     ${suiteResult.failed}`);
      process.exit(1);
    }
  }

  // Shared options builder
  function addCommonTestOptions(cmd: Command): Command {
    return cmd
      .option('--tier <tier>', 'Deployment tier: s, m, l, xl', 's')
      .option('--cloud', 'Run on k6 Cloud instead of locally', false)
      .option('--output-dir <dir>', 'Output directory for results + report')
      .option('--compare <dir>', 'Previous results directory for comparison')
      .option('--format <format>', 'Report format: md or pdf', 'md')
      .option('--namespace <ns>', 'Kubernetes namespace for infra metrics', 'abl')
      .option('--skip-infra', 'Skip infrastructure metrics collection', false)
      .option('--skip-report', 'Run tests only, skip report generation', false)
      .option(
        '--last <count>',
        'Average metrics across last N cloud runs per test (cloud only)',
        '1',
      )
      .option(
        '--scenario-weights <json>',
        'Override scenario weights as JSON (e.g. \'{"single_turn":0.6,"multi_turn":0.4}\')',
      )
      .option(
        '--vus <count>',
        'Override total VU count (overrides tier profile default). Scripts scale all scenario VUs proportionally.',
      )
      .option('--duration <minutes>', 'Override test duration in minutes (saturation tests only)');
  }

  // -------------------------------------------------------------------------
  // sizing service-test — per-service load benchmarks
  // -------------------------------------------------------------------------
  addCommonTestOptions(
    sizing
      .command('service-test')
      .description('Run per-service load tests, collect infra metrics, generate report')
      .option(
        '--services <list>',
        'Comma-separated services or @categories (@all, @compute, @data-stores, @ai)',
        '@all',
      ),
  ).action(async (opts: TestCommandOpts) => {
    await runTestCommand('service', opts);
  });

  // -------------------------------------------------------------------------
  // sizing integration-test — E2E integration flow benchmarks
  // -------------------------------------------------------------------------
  addCommonTestOptions(
    sizing
      .command('integration-test')
      .description('Run integration E2E tests, collect infra metrics, generate report')
      .option(
        '--services <list>',
        'Comma-separated services to filter by, or integration script names (@all for all)',
        '@all',
      ),
  ).action(async (opts: TestCommandOpts) => {
    await runTestCommand('integration', opts);
  });

  // -------------------------------------------------------------------------
  // sizing saturation-test — ramp-to-saturation benchmarks
  // -------------------------------------------------------------------------
  addCommonTestOptions(
    sizing
      .command('saturation-test')
      .description(
        'Run saturation (ramp-to-breaking-point) tests, collect infra metrics, generate report',
      )
      .option(
        '--services <list>',
        'Comma-separated services or @all (available: runtime, search-ai, bge-m3)',
        '@all',
      ),
  ).action(async (opts: TestCommandOpts) => {
    await runTestCommand('saturation', opts);
  });

  // -------------------------------------------------------------------------
  // sizing saturation-find — auto-discover VU tipping point
  // -------------------------------------------------------------------------

  interface SaturationFindOpts {
    services: string;
    tier: string;
    cloud: boolean;
    namespace: string;
    maxRuns: string;
    startVus: string;
    duration: string;
    minStep: string;
    format: string;
    skipInfra: boolean;
  }

  sizing
    .command('saturation-find')
    .description(
      'Auto-discover VU tipping point via adaptive binary search (exponential growth → refinement)',
    )
    .option(
      '--services <list>',
      'Comma-separated services or @all (available: runtime, search-ai, bge-m3)',
      'runtime',
    )
    .option('--tier <tier>', 'Deployment tier: s, m, l, xl', 's')
    .option('--cloud', 'Run on k6 Cloud instead of locally', false)
    .option('--namespace <ns>', 'Kubernetes namespace for infra metrics', 'abl')
    .option('--max-runs <n>', 'Maximum number of test runs (default 5)', '5')
    .option('--start-vus <n>', 'Starting VU count for first run', '10')
    .option('--duration <minutes>', 'Duration per run in minutes', '10')
    .option('--min-step <n>', 'Minimum VU step to stop binary search', '5')
    .option('--format <format>', 'Report format: md or pdf', 'md')
    .option('--skip-infra', 'Skip infrastructure metrics collection', false)
    .action(async (opts: SaturationFindOpts) => {
      await loadCloudEnv();
      // Override namespace from cloud.env if user didn't pass --namespace explicitly
      if (opts.namespace === 'abl' && process.env.NAMESPACE) {
        opts.namespace = process.env.NAMESPACE;
      }

      const { computeNextVUs, evaluateHealth, buildFindResult } =
        await import('./benchmark/saturation-finder.js');
      const { resolveTestScripts, listAvailableScripts, runTestSuite, preAuthenticate } =
        await import('./benchmark/test-runner.js');
      const { collectInfraMetrics } = await import('./benchmark/infra-collector.js');
      const { startMetricsSampler } = await import('./benchmark/kubectl-metrics.js');
      const { SERVICE_REGISTRY } = await import('./benchmark/service-registry.js');
      const {
        registerHandlebarsHelpers,
        fetchCloudResults,
        loadTemplate,
        findRepoRoot,
        generatePdf,
      } = await import('./sizing-report.js');
      const { mkdir: mkdirFn, writeFile: writeFn, readFile: readFn } = await import('fs/promises');
      const { join } = await import('path');

      const maxRuns = parseInt(opts.maxRuns, 10) || 5;
      const startVUs = parseInt(opts.startVus, 10) || 10;
      const durationMinutes = parseInt(opts.duration, 10) || 10;
      const minStep = parseInt(opts.minStep, 10) || 5;

      const config = { startVUs, maxRuns, durationMinutes, minStep };

      const serviceTokens = opts.services
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const scripts = resolveTestScripts(serviceTokens, 'saturation');
      if (scripts.length === 0) {
        process.stderr.write(`No saturation test scripts found for: ${opts.services}\n`);
        const available = listAvailableScripts('saturation');
        process.stderr.write(`Available: ${available.join(', ')}\n`);
        process.exit(1);
      }

      const repoRoot = await findRepoRoot();
      const benchmarksDir = join(repoRoot, 'benchmarks');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const outputDir = join(benchmarksDir, 'results', `saturation-find-${opts.tier}-${timestamp}`);
      await mkdirFn(outputDir, { recursive: true });

      process.stdout.write('\n=== Saturation Find (Adaptive Binary Search) ===\n');
      process.stdout.write(`  Tier:       ${opts.tier}\n`);
      process.stdout.write(`  Services:   ${opts.services}\n`);
      process.stdout.write(`  Start VUs:  ${startVUs}\n`);
      process.stdout.write(`  Duration:   ${durationMinutes}m per run\n`);
      process.stdout.write(`  Max Runs:   ${maxRuns}\n`);
      process.stdout.write(`  Min Step:   ${minStep} VUs\n`);
      process.stdout.write(`  Cloud:      ${opts.cloud}\n`);
      process.stdout.write(`  Output:     ${outputDir}\n\n`);

      // Pre-authenticate once
      await preAuthenticate();

      type RunResultType = import('./benchmark/saturation-finder.js').RunResult;
      const runs: RunResultType[] = [];
      const seenCloudRunIds = new Set<number>();

      for (let runIdx = 0; runIdx < maxRuns; runIdx++) {
        const { vus, phase, done } = computeNextVUs(runs, config);

        if (done && runIdx > 0) {
          process.stdout.write(`\n  Search converged after ${runs.length} run(s).\n`);
          break;
        }

        process.stdout.write(
          `\n--- Run ${runIdx + 1}/${maxRuns} | ${vus} VUs | Phase: ${phase} ---\n`,
        );

        // Set VUs and duration for this run
        process.env.MAX_VUS = String(vus);
        process.env.DURATION_MINUTES = String(durationMinutes);

        const runOutputDir = join(outputDir, `run-${runIdx + 1}-${vus}vus`);
        await mkdirFn(runOutputDir, { recursive: true });

        // Start background metrics sampler
        const sampler = !opts.skipInfra ? startMetricsSampler(opts.namespace, 30_000) : undefined;

        // Run the test
        const suiteResult = await runTestSuite(scripts, {
          benchmarksDir,
          outputDir: runOutputDir,
          cloud: opts.cloud,
          healthCheck: false,
        });

        // Stop sampler
        if (sampler) sampler.stop();

        // Extract metrics from the run
        let errorRate = 0;
        let p95Ms = 0;
        let p99Ms = 0;
        let avgMs = 0;
        let throughputRps = 0;
        let totalRequests = 0;
        let oomKills = 0;

        type RunScenarioType = import('./benchmark/saturation-finder.js').RunScenario;
        type RunInfraType = import('./benchmark/saturation-finder.js').RunInfra;
        type RunLLMMetricsType = import('./benchmark/saturation-finder.js').RunLLMMetrics;
        type RunWSMetricsType = import('./benchmark/saturation-finder.js').RunWSMetrics;
        let runScenarios: RunScenarioType[] | undefined;
        let runInfra: RunInfraType | undefined;
        let runLLM: RunLLMMetricsType | undefined;
        let runWS: RunWSMetricsType | undefined;

        if (opts.cloud) {
          const token = process.env.K6_CLOUD_TOKEN ?? '';
          const projectId = process.env.K6_CLOUD_PROJECT_ID ?? '';
          if (token && projectId) {
            const serviceFilter = scripts.map((s) => s.serviceName.replace(/^sat-/, ''));
            const ctx = await fetchCloudResults(projectId, token, 1, {
              services: serviceFilter,
              testType: 'saturation',
            });

            // Dedup: detect when k6 cloud failed to launch a new test run
            const ctxServices = ctx.services as Record<string, { cloudRunId?: number }>;
            const cloudRunIds = Object.values(ctxServices)
              .map((s) => s.cloudRunId)
              .filter((id): id is number => id != null);
            const isDuplicate =
              cloudRunIds.length > 0 && cloudRunIds.every((id) => seenCloudRunIds.has(id));

            if (isDuplicate) {
              process.stderr.write(
                `  WARNING: k6 Cloud returned a previously seen run (${cloudRunIds.join(', ')}). ` +
                  `The test likely failed to launch. Aborting this run.\n`,
              );
              // Push a synthetic failed run so the algorithm knows this VU count failed
              runs.push({
                runIndex: runIdx,
                vus,
                healthy: false,
                errorRate: 1,
                p95Ms: 0,
                p99Ms: 0,
                avgMs: 0,
                throughputRps: 0,
                totalRequests: 0,
                oomKills: 0,
                trigger: 'test launch failed — no new k6 Cloud run created',
                startedAt: new Date().toISOString(),
                durationSec: 0,
              });
              continue;
            }

            for (const id of cloudRunIds) seenCloudRunIds.add(id);

            const services = ctxServices as Record<
              string,
              {
                cloudRunId?: number;
                errorRate?: number;
                throughput?: string;
                totalRequests?: number;
                latency?: { p95Ms?: number; p99Ms?: number; avgMs?: number };
                scenarios?: Array<{
                  name: string;
                  requests?: number | string;
                  errorRate?: number;
                  throughput?: string;
                  latency?: {
                    avgMs?: number;
                    medianMs?: number;
                    p90Ms?: number;
                    p95Ms?: number;
                    p99Ms?: number;
                    maxMs?: number;
                  };
                }>;
                llmMetrics?: {
                  avgMs: number;
                  medianMs: number;
                  p95Ms: number;
                  maxMs: number;
                  inputTokens: number;
                  outputTokens: number;
                };
                wsMetrics?: {
                  totalConnections: number;
                  connectionErrors: number;
                  connectionTimeouts: number;
                  connectLatency: {
                    avgMs: number;
                    medianMs: number;
                    p95Ms: number;
                    p99Ms: number;
                    maxMs: number;
                  };
                  messageLatency?: {
                    avgMs: number;
                    medianMs: number;
                    p95Ms: number;
                    p99Ms: number;
                    maxMs: number;
                  };
                  messageRequests?: number;
                };
              }
            >;
            for (const svc of Object.values(services)) {
              errorRate = Math.max(errorRate, svc.errorRate ?? 0);
              p95Ms = Math.max(p95Ms, svc.latency?.p95Ms ?? 0);
              p99Ms = Math.max(p99Ms, svc.latency?.p99Ms ?? 0);
              avgMs = Math.max(avgMs, svc.latency?.avgMs ?? 0);
              throughputRps += parseFloat(svc.throughput ?? '0');
              totalRequests += svc.totalRequests ?? 0;

              // Extract scenario breakdown
              if (svc.scenarios && svc.scenarios.length > 0) {
                runScenarios = svc.scenarios.map((s) => ({
                  name: s.name,
                  requests: s.requests ?? 'N/A',
                  errorRate: s.errorRate ?? 0,
                  throughput: s.throughput ?? '0',
                  latency: {
                    avgMs: s.latency?.avgMs ?? 0,
                    medianMs: s.latency?.medianMs ?? 0,
                    p90Ms: s.latency?.p90Ms ?? 0,
                    p95Ms: s.latency?.p95Ms ?? 0,
                    p99Ms: s.latency?.p99Ms ?? 0,
                    maxMs: s.latency?.maxMs ?? 0,
                  },
                }));
              }

              // Extract LLM metrics from cloud context
              if (svc.llmMetrics) {
                runLLM = {
                  avgMs: svc.llmMetrics.avgMs,
                  p95Ms: svc.llmMetrics.p95Ms,
                  medianMs: svc.llmMetrics.medianMs,
                  maxMs: svc.llmMetrics.maxMs,
                  inputTokens: svc.llmMetrics.inputTokens,
                  outputTokens: svc.llmMetrics.outputTokens,
                };
              }

              // Extract WebSocket metrics from cloud context
              if (svc.wsMetrics) {
                runWS = {
                  totalConnections: svc.wsMetrics.totalConnections,
                  connectionErrors: svc.wsMetrics.connectionErrors,
                  connectionTimeouts: svc.wsMetrics.connectionTimeouts,
                  connectLatency: svc.wsMetrics.connectLatency,
                  messageLatency: svc.wsMetrics.messageLatency,
                  messageRequests: svc.wsMetrics.messageRequests,
                };
              }
            }

            // Save cloud context for this run
            await writeFn(join(runOutputDir, 'cloud-context.json'), JSON.stringify(ctx, null, 2));
          }
        } else {
          // Local mode: parse k6 JSON summaries
          const { readdir } = await import('fs/promises');
          const files = await readdir(runOutputDir);
          for (const file of files) {
            if (!file.endsWith('.json') || file === 'cloud-context.json') continue;
            try {
              const raw = await readFn(join(runOutputDir, file), 'utf-8');
              const summary = JSON.parse(raw) as {
                metrics?: {
                  http_req_failed?: { rate?: number };
                  http_req_duration?: {
                    'p(95)'?: number;
                    'p(90)'?: number;
                    avg?: number;
                    max?: number;
                  };
                  http_reqs?: { count?: number; rate?: number };
                  runtime_llm_latency_ms?: {
                    avg?: number;
                    med?: number;
                    'p(95)'?: number;
                    max?: number;
                  };
                  runtime_llm_input_tokens?: { count?: number };
                  runtime_llm_output_tokens?: { count?: number };
                  runtime_ws_connect_latency_ms?: {
                    avg?: number;
                    med?: number;
                    'p(95)'?: number;
                    'p(99)'?: number;
                    max?: number;
                  };
                  runtime_ws_timeouts?: { count?: number };
                  runtime_concurrent_requests?: { count?: number };
                  runtime_concurrent_errors?: { count?: number };
                  runtime_multi_turn_per_message_ms?: {
                    avg?: number;
                    med?: number;
                    'p(95)'?: number;
                    'p(99)'?: number;
                    max?: number;
                  };
                  runtime_multi_turn_requests?: { count?: number };
                };
              };
              const m = summary.metrics;
              if (m) {
                errorRate = Math.max(errorRate, m.http_req_failed?.rate ?? 0);
                p95Ms = Math.max(p95Ms, m.http_req_duration?.['p(95)'] ?? 0);
                avgMs = Math.max(avgMs, m.http_req_duration?.avg ?? 0);
                throughputRps += m.http_reqs?.rate ?? 0;
                totalRequests += m.http_reqs?.count ?? 0;
                // Approximate p99
                const p95v = m.http_req_duration?.['p(95)'] ?? 0;
                const p90v = m.http_req_duration?.['p(90)'] ?? 0;
                const maxV = m.http_req_duration?.max ?? p95v;
                const est99 = p95v > 0 ? Math.min(p95v + 0.8 * (p95v - p90v), maxV) : 0;
                p99Ms = Math.max(p99Ms, est99);

                // Extract LLM metrics from k6 custom Trend/Counter
                const llmTrend = m.runtime_llm_latency_ms;
                if (llmTrend && llmTrend.avg != null) {
                  runLLM = {
                    avgMs: parseFloat((llmTrend.avg ?? 0).toFixed(1)),
                    p95Ms: parseFloat((llmTrend['p(95)'] ?? 0).toFixed(1)),
                    medianMs: parseFloat((llmTrend.med ?? 0).toFixed(1)),
                    maxMs: parseFloat((llmTrend.max ?? 0).toFixed(1)),
                    inputTokens: m.runtime_llm_input_tokens?.count ?? 0,
                    outputTokens: m.runtime_llm_output_tokens?.count ?? 0,
                  };
                }

                // Extract WebSocket metrics from k6 custom Trend/Counter
                const wsConnect = m.runtime_ws_connect_latency_ms;
                if (wsConnect) {
                  runWS = {
                    totalConnections: m.runtime_concurrent_requests?.count ?? 0,
                    connectionErrors: m.runtime_concurrent_errors?.count ?? 0,
                    connectionTimeouts: m.runtime_ws_timeouts?.count ?? 0,
                    connectLatency: {
                      avgMs: parseFloat((wsConnect.avg ?? wsConnect.med ?? 0).toFixed(1)),
                      medianMs: parseFloat((wsConnect.med ?? 0).toFixed(1)),
                      p95Ms: parseFloat((wsConnect['p(95)'] ?? 0).toFixed(1)),
                      p99Ms: parseFloat((wsConnect['p(99)'] ?? 0).toFixed(1)),
                      maxMs: parseFloat((wsConnect.max ?? 0).toFixed(1)),
                    },
                  };
                  const msgTrend = m.runtime_multi_turn_per_message_ms;
                  if (msgTrend && (msgTrend.med != null || msgTrend['p(95)'] != null)) {
                    runWS.messageLatency = {
                      avgMs: parseFloat((msgTrend.avg ?? msgTrend.med ?? 0).toFixed(1)),
                      medianMs: parseFloat((msgTrend.med ?? 0).toFixed(1)),
                      p95Ms: parseFloat((msgTrend['p(95)'] ?? 0).toFixed(1)),
                      p99Ms: parseFloat((msgTrend['p(99)'] ?? 0).toFixed(1)),
                      maxMs: parseFloat((msgTrend.max ?? 0).toFixed(1)),
                    };
                    runWS.messageRequests = m.runtime_multi_turn_requests?.count ?? 0;
                  }
                }
              }
            } catch {
              // skip unparseable files
            }
          }
        }

        // Collect infra metrics for OOM detection + per-run infra detail
        if (!opts.skipInfra) {
          try {
            const allServiceNames = new Set<string>();
            for (const script of scripts) {
              if (script.services && script.services.length > 0) {
                for (const svc of script.services) allServiceNames.add(svc);
              } else {
                allServiceNames.add(script.serviceName);
              }
            }

            // Include data stores for full infra report
            for (const dsName of [
              'mongodb',
              'redis',
              'clickhouse',
              'opensearch',
              'qdrant',
              'neo4j',
              'restate',
            ]) {
              allServiceNames.add(dsName);
            }

            const infraServices = Array.from(allServiceNames)
              .filter((name) => SERVICE_REGISTRY[name])
              .map((name) => ({
                name,
                deploymentName: SERVICE_REGISTRY[name].deploymentName,
                category: SERVICE_REGISTRY[name].category,
              }));

            const infraPath = await collectInfraMetrics({
              services: infraServices,
              namespace: opts.namespace,
              fromTimestamp: suiteResult.startTime,
              toTimestamp: suiteResult.endTime,
              outputPath: join(runOutputDir, 'infra-metrics.json'),
              sampler,
            });

            if (infraPath) {
              const infraRaw = await readFn(infraPath, 'utf-8');
              const infraFile = JSON.parse(infraRaw) as {
                services?: Record<
                  string,
                  {
                    infra?: {
                      cpuPeak?: string;
                      cpuAvg?: string;
                      memoryPeak?: string;
                      memoryAvg?: string;
                      podRestarts?: number;
                      oomKills?: number;
                      observedRps?: number | string;
                    };
                  }
                >;
              };
              if (infraFile.services) {
                for (const svc of Object.values(infraFile.services)) {
                  oomKills += svc.infra?.oomKills ?? 0;
                  // Use the first service with infra data as the run's infra
                  if (!runInfra && svc.infra) {
                    runInfra = {
                      cpuPeak: svc.infra.cpuPeak ?? 'N/A',
                      cpuAvg: svc.infra.cpuAvg ?? 'N/A',
                      memoryPeak: svc.infra.memoryPeak ?? 'N/A',
                      memoryAvg: svc.infra.memoryAvg ?? 'N/A',
                      podRestarts: svc.infra.podRestarts ?? 0,
                      oomKills: svc.infra.oomKills ?? 0,
                      observedRps: svc.infra.observedRps ?? 'N/A',
                    };
                  }
                }
              }
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`  Warning: infra metrics collection failed: ${message}\n`);
          }
        }

        const durationSec = Math.round((suiteResult.endTime - suiteResult.startTime) / 1000);
        const { healthy, trigger } = evaluateHealth({ errorRate, p95Ms, oomKills });

        const runResult: RunResultType = {
          runIndex: runIdx,
          vus,
          healthy,
          errorRate,
          p95Ms,
          p99Ms,
          avgMs,
          throughputRps: parseFloat(throughputRps.toFixed(1)),
          totalRequests,
          oomKills,
          trigger,
          startedAt: new Date(suiteResult.startTime).toISOString(),
          durationSec,
          scenarios: runScenarios,
          infra: runInfra,
          llm: runLLM,
          ws: runWS,
        };

        runs.push(runResult);

        const statusIcon = healthy ? 'PASS' : 'FAIL';
        process.stdout.write(
          `  Result: ${statusIcon} | error=${(errorRate * 100).toFixed(1)}% | ` +
            `p95=${p95Ms.toFixed(0)}ms | rps=${throughputRps.toFixed(1)} | ` +
            `trigger=${trigger}\n`,
        );
      }

      // Build final result
      const findResult = buildFindResult(runs, config);

      // Save raw results
      await writeFn(
        join(outputDir, 'saturation-find-result.json'),
        JSON.stringify(findResult, null, 2),
      );

      // Generate report
      process.stdout.write('\n--- Generating Saturation Find Report ---\n');
      const { generateInsights } = await import('./sizing-report.js');
      registerHandlebarsHelpers();

      const hasAnyScenarios = findResult.runs.some((r) => r.scenarios && r.scenarios.length > 0);
      const hasAnyInfra = findResult.runs.some((r) => !!r.infra);

      const context: Record<string, unknown> = {
        tier: opts.tier,
        services: opts.services,
        config,
        runs: findResult.runs,
        tippingPointVUs: findResult.tippingPointVUs,
        firstUnhealthyVUs: findResult.firstUnhealthyVUs,
        converged: findResult.converged,
        phase: findResult.phase,
        totalDurationSec: findResult.totalDurationSec,
        totalRuns: findResult.runs.length,
        generatedAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        hasTippingPoint: findResult.tippingPointVUs !== null,
        hasUnhealthy: findResult.firstUnhealthyVUs !== null,
        hasAnyScenarios,
        hasAnyInfra,
        hasAnyLLM: findResult.runs.some((r) => !!r.llm),
        hasAnyWS: findResult.runs.some((r) => !!r.ws),
      };

      // Identify the best healthy run for capacity summary
      const healthyRuns = findResult.runs.filter((r) => r.healthy);
      if (healthyRuns.length > 0) {
        const best = healthyRuns.reduce((a, b) => (a.vus > b.vus ? a : b));
        context.bestRun = best;
      }

      // Enrich with full infra from the last run (deployments, data stores,
      // connection breakdown, service-to-datastore latency, per-pod capacity)
      const lastRunDir = join(
        outputDir,
        `run-${findResult.runs.length}-${findResult.runs[findResult.runs.length - 1].vus}vus`,
      );
      const lastInfraPath = join(lastRunDir, 'infra-metrics.json');
      try {
        const infraRaw = await readFn(lastInfraPath, 'utf-8');
        const infraFile = JSON.parse(infraRaw) as Record<string, unknown>;

        if (infraFile.services && typeof infraFile.services === 'object') {
          const svcServices: Record<string, Record<string, unknown>> = {};
          const deployments: Array<Record<string, unknown>> = [];
          let enrichedCount = 0;

          for (const [serviceName, infraData] of Object.entries(
            infraFile.services as Record<string, Record<string, unknown>>,
          )) {
            const infra = infraData as {
              infra?: unknown;
              dataStore?: unknown;
              deployment?: {
                replicas?: number;
                readyReplicas?: number;
                cpuRequest?: string | null;
                memoryRequest?: string | null;
                cpuLimit?: string | null;
                memoryLimit?: string | null;
                kind?: string;
              };
            };

            // Build service entries for the template
            if (infra.infra || infra.dataStore) {
              svcServices[serviceName] = {
                totalRequests: 0,
                errorRate: 0,
                throughput: '0',
                latency: { minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 },
              };
              if (infra.infra) {
                svcServices[serviceName].infra = infra.infra;
                enrichedCount++;
              }
              if (infra.dataStore) {
                svcServices[serviceName].dataStoreInfra = infra.dataStore;
                enrichedCount++;
              }
            }

            if (infra.deployment) {
              deployments.push({
                name: serviceName,
                kind: infra.deployment.kind ?? 'Deployment',
                replicas: infra.deployment.replicas ?? 0,
                readyReplicas: infra.deployment.readyReplicas ?? 0,
                cpuRequest: infra.deployment.cpuRequest ?? 'N/A',
                memoryRequest: infra.deployment.memoryRequest ?? 'N/A',
                cpuLimit: infra.deployment.cpuLimit ?? 'N/A',
                memoryLimit: infra.deployment.memoryLimit ?? 'N/A',
              });
            }
          }

          // Merge tested service k6 metrics into the infra service entries
          if (context.bestRun) {
            const best = context.bestRun as {
              vus: number;
              throughputRps: number;
              errorRate: number;
              p95Ms: number;
              p99Ms: number;
              avgMs: number;
              totalRequests: number;
            };
            // Find the tested service name (first script's service)
            const testedName = scripts[0].serviceName.replace(/^sat-/, '');
            const cleanName = testedName.replace(/-saturation$/, '');
            const svcKey =
              Object.keys(svcServices).find(
                (k) =>
                  k === testedName ||
                  k === cleanName ||
                  k.startsWith(testedName) ||
                  k.startsWith(cleanName),
              ) ?? testedName;
            if (!svcServices[svcKey]) {
              svcServices[svcKey] = {};
            }
            svcServices[svcKey].totalRequests = best.totalRequests;
            svcServices[svcKey].errorRate = best.errorRate;
            svcServices[svcKey].throughput = String(best.throughputRps);
            svcServices[svcKey].vus = best.vus;
            svcServices[svcKey].latency = {
              p95Ms: best.p95Ms,
              p99Ms: best.p99Ms,
              avgMs: best.avgMs,
            };
          }

          context.infraServices = svcServices;
          context.hasInfraMetrics = enrichedCount > 0;
          context.infraMetricsSource = (infraFile.source as string) ?? 'unknown';
          context.corootProject = (infraFile.project as string) ?? '';

          if (deployments.length > 0) {
            context.deployments = deployments;
            context.hasDeployments = true;
          }

          // Service-to-datastore latency
          const serviceLatency = (infraFile as Record<string, unknown>).serviceLatency as
            | unknown[]
            | undefined;
          if (serviceLatency && Array.isArray(serviceLatency) && serviceLatency.length > 0) {
            context.serviceLatency = serviceLatency;
            context.hasServiceLatency = true;
          }

          // Cluster nodes
          const nodes = (infraFile as Record<string, unknown>).nodes as
            | Array<{ cloudProvider?: string; region?: string }>
            | undefined;
          if (nodes && Array.isArray(nodes) && nodes.length > 0) {
            context.nodes = nodes;
            context.hasNodes = true;
            context.nodeCount = nodes.length;
            context.clusterCloud = nodes[0]?.cloudProvider ?? 'unknown';
            context.clusterRegion = nodes[0]?.region ?? 'unknown';
          }

          // Pod-to-node placement
          const podPlacement = (infraFile as Record<string, unknown>).podPlacement as
            | unknown[]
            | undefined;
          if (podPlacement && Array.isArray(podPlacement) && podPlacement.length > 0) {
            context.podPlacement = podPlacement;
            context.hasPodPlacement = true;
          }

          // Per-pod capacity from best healthy run
          if (context.bestRun && deployments.length > 0) {
            const best = context.bestRun as {
              vus: number;
              throughputRps: number;
              errorRate: number;
              p95Ms: number;
              p99Ms: number;
            };
            const testedName = scripts[0].serviceName.replace(/^sat-/, '');
            const cleanName = testedName.replace(/-saturation$/, '').replace(/-service$/, '');
            const depInfo = deployments.find((d) => d.name === cleanName || d.name === testedName);
            const replicas = (depInfo?.replicas as number) ?? 0;
            if (replicas > 0) {
              context.recommendations = [
                {
                  service: cleanName,
                  replicas,
                  totalRps: best.throughputRps,
                  perPodRps: parseFloat((best.throughputRps / replicas).toFixed(1)),
                  totalVUs: best.vus,
                  perPodVUs: Math.round(best.vus / replicas),
                  p95Ms: parseFloat(best.p95Ms.toFixed(1)),
                  p99Ms: parseFloat(best.p99Ms.toFixed(1)),
                  errorRate: parseFloat((best.errorRate * 100).toFixed(2)),
                  healthy: best.errorRate < 0.01 && best.p95Ms < 2000,
                },
              ];
              context.hasRecommendations = true;
            }
          }

          // Populate WebSocket context on the tested service from the best run's WS metrics
          const bestRunForWs = context.bestRun as
            | { ws?: import('./benchmark/saturation-finder.js').RunWSMetrics }
            | undefined;
          const wsData = bestRunForWs?.ws;
          if (wsData) {
            const testedName = scripts[0].serviceName.replace(/^sat-/, '');
            const cleanName = testedName.replace(/-saturation$/, '');
            const svcKey =
              Object.keys(svcServices).find(
                (k) =>
                  k === testedName ||
                  k === cleanName ||
                  k.startsWith(testedName) ||
                  k.startsWith(cleanName),
              ) ?? cleanName;
            if (svcServices[svcKey]) {
              const depInfo = deployments.find(
                (d) => d.name === cleanName || d.name === testedName,
              );
              const replicas = (depInfo?.replicas as number) ?? 0;
              const connectionsPerPod =
                replicas > 0
                  ? Math.round(wsData.totalConnections / replicas)
                  : wsData.totalConnections;
              svcServices[svcKey].websocket = {
                maxTotalConnectionsPerPod: connectionsPerPod,
                estimatedMemoryPerConnection: 'N/A',
                connectionErrors: wsData.connectionErrors,
                connectionTimeouts: wsData.connectionTimeouts,
                unexpectedDisconnects: 0,
                heartbeatFailures: 0,
                connectLatency: wsData.connectLatency,
                messageLatency: wsData.messageLatency ?? null,
                messageRequests: wsData.messageRequests ?? 0,
                endpoints: [
                  {
                    path: '/ws',
                    configuredMax: 'N/A',
                    measuredMax: wsData.totalConnections,
                    saturationSignal:
                      wsData.connectionErrors > 0
                        ? 'Connection errors'
                        : wsData.connectionTimeouts > 0
                          ? 'Timeouts'
                          : 'None',
                    messageLatency: wsData.messageLatency
                      ? {
                          p50Ms: wsData.messageLatency.medianMs,
                          p95Ms: wsData.messageLatency.p95Ms,
                        }
                      : { p50Ms: 0, p95Ms: 0 },
                  },
                ],
              };
            }
          }

          process.stdout.write(
            `  Infra enrichment: ${enrichedCount} service(s), ${deployments.length} deployment(s)\n`,
          );
        }
      } catch {
        // Last run's infra-metrics.json not found — skip enrichment
      }

      // Generate insights from infra-enriched context
      // Use infraServices as the 'services' key for generateInsights
      if (context.infraServices) {
        const savedServices = context.services;
        context.services = context.infraServices;
        generateInsights(context);
        context.services = savedServices;
      }

      const template = await loadTemplate('saturation-find');
      const markdown = template(context);
      const mdPath = join(outputDir, 'saturation-find-report.md');
      await writeFn(mdPath, markdown);
      process.stdout.write(`  Report written to ${mdPath}\n`);

      if (opts.format === 'pdf') {
        const cssPath = join(repoRoot, 'benchmarks', 'report', 'styles', 'customer-report.css');
        const pdfPath = join(outputDir, 'saturation-find-report.pdf');
        const ok = await generatePdf(mdPath, pdfPath, cssPath);
        if (ok) {
          process.stdout.write(`  PDF written to ${pdfPath}\n`);
        }
      }

      // Print summary
      process.stdout.write('\n=== Saturation Find Complete ===\n');
      process.stdout.write(`  Total Runs: ${findResult.runs.length}\n`);
      process.stdout.write(`  Converged:  ${findResult.converged ? 'Yes' : 'No'}\n`);
      if (findResult.tippingPointVUs !== null) {
        process.stdout.write(`  Tipping Point: ~${findResult.tippingPointVUs} VUs (max healthy)\n`);
      }
      if (findResult.firstUnhealthyVUs !== null) {
        process.stdout.write(`  First Unhealthy: ${findResult.firstUnhealthyVUs} VUs\n`);
      }
      process.stdout.write(`  Results:    ${outputDir}\n`);
    });

  // -------------------------------------------------------------------------
  // sizing service-smoke — quick sanity check for service scripts
  // -------------------------------------------------------------------------
  sizing
    .command('service-smoke')
    .description('Smoke test per-service scripts (1 VU, 1 iteration, no thresholds)')
    .option(
      '--services <list>',
      'Comma-separated services or @categories (@all, @compute, @data-stores, @ai)',
      '@all',
    )
    .option('--namespace <ns>', 'Kubernetes namespace (env: NAMESPACE)', 'abl')
    .action(async (opts: SmokeCommandOpts) => {
      await runSmokeCommand('service', opts);
    });

  // -------------------------------------------------------------------------
  // sizing integration-smoke — quick sanity check for integration scripts
  // -------------------------------------------------------------------------
  sizing
    .command('integration-smoke')
    .description('Smoke test integration E2E scripts (1 VU, 1 iteration, no thresholds)')
    .option(
      '--services <list>',
      'Comma-separated services or integration script names (@all for all)',
      '@all',
    )
    .option('--namespace <ns>', 'Kubernetes namespace (env: NAMESPACE)', 'abl')
    .action(async (opts: SmokeCommandOpts) => {
      await runSmokeCommand('integration', opts);
    });

  // -------------------------------------------------------------------------
  // sizing saturation-smoke — quick sanity check for saturation scripts
  // -------------------------------------------------------------------------
  sizing
    .command('saturation-smoke')
    .description('Smoke test saturation scripts (1 VU, 1 iteration, no thresholds)')
    .option(
      '--services <list>',
      'Comma-separated services or @all (available: runtime, search-ai, bge-m3)',
      '@all',
    )
    .option('--namespace <ns>', 'Kubernetes namespace (env: NAMESPACE)', 'abl')
    .action(async (opts: SmokeCommandOpts) => {
      await runSmokeCommand('saturation', opts);
    });
}
