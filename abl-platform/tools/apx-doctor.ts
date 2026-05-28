import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatApxDoctorReport,
  runApxDoctor,
  type ApxDoctorProgressEvent,
  type ApxDoctorOptions,
  type ApxDoctorReport,
} from './apx-doctor-lib.js';

export interface ApxDoctorCliOptions extends ApxDoctorOptions {
  help: boolean;
  json: boolean;
  strict: boolean;
}

export function parseApxDoctorArgs(argv: string[]): ApxDoctorCliOptions {
  const options: ApxDoctorCliOptions = {
    help: false,
    json: false,
    live: true,
    strict: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--no-live') {
      options.live = false;
      continue;
    }
    if (arg === '--strict') {
      options.strict = true;
      continue;
    }
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Expected a path after --root');
      }
      options.rootDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (!value) {
        throw new Error('Expected a non-empty path for --root');
      }
      options.rootDir = value;
      continue;
    }
    if (arg === '--timeout-ms') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Expected a number after --timeout-ms');
      }
      options.timeoutMs = parseTimeoutMs(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--timeout-ms=')) {
      options.timeoutMs = parseTimeoutMs(arg.slice('--timeout-ms='.length));
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function shouldExitNonZero(report: ApxDoctorReport, strict: boolean): boolean {
  if (report.summary.status === 'fail') {
    return true;
  }

  return strict && report.summary.status === 'warn';
}

function parseTimeoutMs(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --timeout-ms value: ${value}`);
  }
  return parsed;
}

function formatHelp(): string {
  return [
    'apx doctor',
    '',
    'Repo-focused environment readiness checks for configuration, deployment, integration, and health.',
    '',
    'Usage:',
    '  apx doctor [--json] [--no-live] [--strict] [--timeout-ms <ms>] [--root <path>]',
    '',
    'Flags:',
    '  --json              Print the full report as JSON',
    '  --no-live           Skip HTTP/TCP reachability probes',
    '  --strict            Exit non-zero on warnings as well as failures',
    '  --timeout-ms <ms>   Override live probe timeout in milliseconds',
    '  --root <path>       Run against a different repo root',
  ].join('\n');
}

function createProgressReporter(enabled: boolean): {
  onProgress?: (event: ApxDoctorProgressEvent) => void;
  finish: () => void;
} {
  if (!enabled) {
    return { finish: () => {} };
  }

  const stream = process.stderr;
  let activeLine = '';

  const clearActiveLine = () => {
    if (!stream.isTTY || activeLine.length === 0) {
      return;
    }
    stream.write('\r\x1b[2K');
    activeLine = '';
  };

  const writeLine = (message: string) => {
    clearActiveLine();
    stream.write(`${message}\n`);
  };

  const writeProgress = (message: string) => {
    if (!stream.isTTY) {
      writeLine(message);
      return;
    }
    activeLine = message;
    stream.write(`\r\x1b[2K${message}`);
  };

  return {
    onProgress: (event) => {
      if (event.type === 'phase-start') {
        writeLine(`[doctor] ${event.label}...`);
        return;
      }

      if (event.type === 'phase-complete') {
        writeLine(
          `[doctor] ${event.label}: ${event.counts.pass} pass, ${event.counts.warn} warn, ${event.counts.fail} fail, ${event.counts.skip} skip`,
        );
        return;
      }

      const suffix =
        event.status === 'fail'
          ? ` FAIL: ${event.label}`
          : event.status === 'warn'
            ? ` WARN: ${event.label}`
            : '';
      writeProgress(`[doctor] ${event.category} probes ${event.completed}/${event.total}${suffix}`);
    },
    finish: () => {
      clearActiveLine();
    },
  };
}

async function main(): Promise<void> {
  const options = parseApxDoctorArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(`${formatHelp()}\n`);
    return;
  }

  const progress = createProgressReporter(!options.json && process.stderr.isTTY);

  const report = await runApxDoctor({
    live: options.live,
    onProgress: progress.onProgress,
    rootDir: options.rootDir,
    timeoutMs: options.timeoutMs,
  });
  progress.finish();

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatApxDoctorReport(report).join('\n')}\n`);
  }

  if (shouldExitNonZero(report, options.strict)) {
    process.exitCode = 1;
  }
}

const isMain = resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (process.stderr.isTTY) {
      process.stderr.write('\r\x1b[2K');
    }
    process.stderr.write(`apx doctor failed: ${message}\n`);
    process.exitCode = 1;
  });
}
