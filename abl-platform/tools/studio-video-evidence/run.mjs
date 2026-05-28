#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_OUTPUT_ROOT, DEFAULT_VIEWPORT } from './lib/constants.mjs';
import { ensureIsolatedBuildArtifacts } from './lib/build.mjs';
import { maybeConvertVideo } from './lib/media.mjs';
import { loadPlaywright } from './lib/playwright.mjs';
import { scaffoldScenario } from './lib/scaffold.mjs';
import {
  startIsolatedStack,
  stopIsolatedStack,
  waitForExistingEndpoints,
  waitForIsolatedStack,
} from './lib/stack.mjs';
import { STUDIO_SURFACES } from './lib/studio-harness.mjs';
import { createArtifactHelpers, devLogin } from './lib/studio-chat.mjs';
import { getScenarioById, SCENARIOS } from './scenarios/index.mjs';
import { boolFromInput, ensureDir, resolveOutputDir } from './lib/utils.mjs';

function parseArgs(argv) {
  const options = {
    scenario: '',
    mode: 'isolated',
    outputRoot: DEFAULT_OUTPUT_ROOT,
    headed: false,
    list: false,
    listSurfaces: false,
    help: false,
    scaffoldScenario: '',
    scaffoldOutput: '',
    force: false,
  };

  const nextValue = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '--list-surfaces':
        options.listSurfaces = true;
        break;
      case '--scenario':
        options.scenario = nextValue(index, arg);
        index += 1;
        break;
      case '--scaffold-scenario':
        options.scaffoldScenario = nextValue(index, arg);
        index += 1;
        break;
      case '--scaffold-output':
        options.scaffoldOutput = nextValue(index, arg);
        index += 1;
        break;
      case '--mode':
        options.mode = nextValue(index, arg);
        index += 1;
        break;
      case '--output-dir':
      case '--output-root':
        options.outputRoot = nextValue(index, arg);
        index += 1;
        break;
      case '--headed':
        options.headed = true;
        break;
      case '--force':
        options.force = true;
        break;
      default: {
        if (!arg.startsWith('--')) {
          throw new Error(`Unexpected positional argument: ${arg}`);
        }
        const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        const nextArg = argv[index + 1];
        if (!nextArg || nextArg.startsWith('--')) {
          options[key] = true;
        } else {
          options[key] = nextArg;
          index += 1;
        }
      }
    }
  }

  return options;
}

function renderUsage() {
  return [
    'Usage:',
    '  pnpm studio:video:evidence -- --scenario <id> [options]',
    '  pnpm studio:video:evidence -- --surface <surface-id> [options]',
    '  pnpm studio:video:evidence -- --scaffold-scenario <id> [options]',
    '',
    'Core flags:',
    '  --list                       List built-in scenarios',
    '  --list-surfaces              List reusable Studio surfaces',
    '  --scenario <id>              Scenario id to execute (default: studio-chat-single-turn)',
    '  --surface <id>               Surface shortcut (runs studio-surface-capture when no scenario is set)',
    '  --scaffold-scenario <id>     Generate a new scenario file from the shared harness',
    '  --scaffold-output <path>     Custom output path for the scaffolded scenario file',
    '  --force                      Allow scaffold output overwrite',
    '  --mode <isolated|existing>   Start an isolated Studio stack or reuse existing URLs',
    '  --output-dir <path>          Root directory for captured artifacts',
    '  --headed                     Run the browser headed for interactive debugging',
    '  --skip-ready-check           In existing mode, skip /health and e2e-ready readiness probes',
    '',
    'Common scenario options:',
    '  --email <email>             Login as a specific dev-login user instead of generating a disposable email',
    '  --login-name <name>        Override the dev-login display name',
    '  --user-message <text>        Message sent in Studio chat',
    '  --assistant-reply <text>     Static assistant reply seeded into the disposable agent',
    '  --project-id <id>            Reuse an existing Studio project instead of creating a disposable one',
    '  --agent-name <name>          Reuse an existing Studio agent instead of creating a disposable one',
    '  --wait-for-selector <css>    Extra selector to wait for in studio-surface-capture',
    '  --wait-for-text <text>       Extra visible text to wait for in studio-surface-capture',
    '  --screenshot-name <name>     Override the ready-state screenshot name',
    '  --sample-count <n>           Number of live user-bubble samples to take',
    '  --sample-interval-ms <n>     Delay between live bubble samples',
    '',
    'Examples:',
    '  pnpm studio:video:evidence -- --list',
    '  pnpm studio:video:evidence -- --list-surfaces',
    '  pnpm studio:video:evidence -- --scenario studio-chat-single-turn',
    '  pnpm studio:video:evidence -- --surface agent-chat --headed',
    '  pnpm studio:video:evidence -- --scaffold-scenario studio-agent-editor-proof --surface agent-editor',
    '  pnpm studio:video:evidence -- --scenario studio-chat-single-turn --user-message "Hello" --assistant-reply "Hi there"',
  ].join('\n');
}

function printScenarioList() {
  process.stdout.write('Available Studio video evidence scenarios:\n\n');
  for (const scenario of SCENARIOS) {
    process.stdout.write(`- ${scenario.id}\n`);
    process.stdout.write(`  ${scenario.description}\n`);
    if (scenario.example) {
      process.stdout.write(`  Example: ${scenario.example}\n`);
    }
    process.stdout.write('\n');
  }
}

function printSurfaceList() {
  process.stdout.write('Available Studio harness surfaces:\n\n');
  for (const surface of STUDIO_SURFACES) {
    const requirements = [];
    if (surface.requiresProject) requirements.push('project');
    if (surface.requiresAgent) requirements.push('agent');

    process.stdout.write(`- ${surface.id}\n`);
    process.stdout.write(`  ${surface.description}\n`);
    process.stdout.write(
      `  Requires: ${requirements.length > 0 ? requirements.join(', ') : 'login only'}\n`,
    );
    process.stdout.write('\n');
  }
}

function log(message) {
  process.stdout.write(`[studio-video-evidence] ${message}\n`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    process.stderr.write(`${renderUsage()}\n`);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    process.stdout.write(`${renderUsage()}\n`);
    return;
  }

  if (options.list) {
    printScenarioList();
    return;
  }

  if (options.listSurfaces) {
    printSurfaceList();
    return;
  }

  if (options.scaffoldScenario) {
    const scaffold = scaffoldScenario({
      scenarioId: options.scaffoldScenario,
      surfaceId: String(options.surface ?? 'agent-chat').trim() || 'agent-chat',
      title: String(options.title ?? '').trim(),
      description: String(options.description ?? '').trim(),
      outputPath: String(options.scaffoldOutput ?? '').trim(),
      force: boolFromInput(options.force, false),
    });
    process.stdout.write(`${JSON.stringify(scaffold, null, 2)}\n`);
    return;
  }

  const scenarioId =
    options.scenario || (options.surface ? 'studio-surface-capture' : 'studio-chat-single-turn');
  const scenario = getScenarioById(scenarioId);
  if (!scenario) {
    process.stderr.write(`Unknown scenario "${String(scenarioId)}".\n\n`);
    printScenarioList();
    process.exitCode = 1;
    return;
  }

  const outputDir = resolveOutputDir(options.outputRoot, scenario.id);
  const screenshotsDir = path.join(outputDir, 'screenshots');
  const rawVideoDir = path.join(outputDir, 'video-raw');
  ensureDir(outputDir);
  ensureDir(screenshotsDir);
  ensureDir(rawVideoDir);

  const manifestPath = path.join(outputDir, 'manifest.json');
  const startedAt = new Date().toISOString();
  const manifest = {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    status: 'running',
    startedAt,
    finishedAt: null,
    mode: options.mode,
    studioBaseUrl: null,
    runtimeBaseUrl: null,
    outputDir,
    manifestPath,
    video: null,
    rawVideo: null,
    screenshots: [],
    summary: '',
    metadata: {},
    assertions: [],
    error: null,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  let stackHandle = null;
  let browser = null;
  let context = null;
  let page = null;
  let artifacts = null;
  let pageVideo = null;

  try {
    let endpoints;
    if (options.mode === 'isolated') {
      process.env.SDK_BROWSER_E2E_ISOLATED = 'true';
      await ensureIsolatedBuildArtifacts({
        autoBuild: !boolFromInput(options.noBuild, false),
        log,
      });
      log('Starting isolated Studio + Runtime stack');
      stackHandle = startIsolatedStack();
      endpoints = await waitForIsolatedStack(stackHandle);
    } else if (options.mode === 'existing') {
      delete process.env.SDK_BROWSER_E2E_ISOLATED;
      log('Waiting for existing Studio + Runtime endpoints');
      endpoints = await waitForExistingEndpoints({
        skipReadyCheck: boolFromInput(options.skipReadyCheck, false),
      });
    } else {
      throw new Error(
        `Unsupported mode "${String(options.mode)}". Expected "isolated" or "existing".`,
      );
    }

    manifest.studioBaseUrl = endpoints.studioBaseUrl;
    manifest.runtimeBaseUrl = endpoints.runtimeBaseUrl;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ headless: !boolFromInput(options.headed, false) });
    context = await browser.newContext({
      viewport: DEFAULT_VIEWPORT,
      recordVideo: { dir: rawVideoDir, size: DEFAULT_VIEWPORT },
    });
    page = await context.newPage();
    pageVideo = page.video();

    artifacts = createArtifactHelpers({ page, screenshotsDir, log });
    const scenarioResult = await scenario.run({
      scenario,
      options,
      outputDir,
      baseUrl: endpoints.studioBaseUrl,
      runtimeBaseUrl: endpoints.runtimeBaseUrl,
      browser,
      context,
      page,
      log,
      artifacts,
      helpers: {
        devLogin: async (email, name = 'Studio Video Evidence User') =>
          await devLogin(endpoints.studioBaseUrl, { email, name }),
      },
    });

    await context.close();
    context = null;

    const rawVideoPath = pageVideo
      ? await pageVideo.path().catch(() => null)
      : artifacts.findRecordedVideo(rawVideoDir);
    const finalVideoPath = rawVideoPath ? maybeConvertVideo(rawVideoPath, outputDir) : null;

    manifest.status = 'passed';
    manifest.finishedAt = new Date().toISOString();
    manifest.rawVideo = rawVideoPath;
    manifest.video = finalVideoPath ?? rawVideoPath;
    manifest.screenshots = artifacts.screenshots;
    manifest.summary = scenarioResult.summary;
    manifest.metadata = scenarioResult.metadata ?? {};
    manifest.assertions = scenarioResult.assertions ?? [];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    if (page && artifacts) {
      const failureScreenshot = await artifacts.captureFailureScreenshot();
      manifest.screenshots = failureScreenshot ? [...artifacts.screenshots] : artifacts.screenshots;
    }

    if (context) {
      try {
        await context.close();
      } catch {
        // Best effort.
      }
      context = null;
    }

    const rawVideoPath =
      pageVideo && pageVideo.path
        ? await pageVideo.path().catch(() => null)
        : (artifacts?.findRecordedVideo(rawVideoDir) ?? null);
    const finalVideoPath = rawVideoPath ? maybeConvertVideo(rawVideoPath, outputDir) : null;

    manifest.status = 'failed';
    manifest.finishedAt = new Date().toISOString();
    manifest.rawVideo = rawVideoPath;
    manifest.video = finalVideoPath ?? rawVideoPath;
    manifest.error = error instanceof Error ? error.message : String(error);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    process.stderr.write(`${manifest.error}\n`);
    process.stderr.write(`Manifest: ${manifestPath}\n`);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (stackHandle) {
      await stopIsolatedStack(stackHandle);
    }
  }
}

void main();
