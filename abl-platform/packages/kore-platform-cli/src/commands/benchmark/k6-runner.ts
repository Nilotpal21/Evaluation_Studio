/**
 * k6 Runner for Benchmark Orchestrator
 *
 * Spawns k6 saturation test processes and parses their JSON summary output.
 */

import { execFile as execFileCb } from 'child_process';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

export interface K6SaturationResult {
  latency: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    minMs: number;
    maxMs: number;
  };
  errorRate: number;
  rps: number;
  maxVUs: number;
  durationMs: number;
  timestamps: {
    start: string;
    end: string;
  };
  summaryPath: string;
}

export interface K6RunOptions {
  scriptPath: string;
  summaryOutputPath: string;
  targetUrl: string;
  maxDurationSeconds: number;
  benchmarksDir: string;
  env?: Record<string, string>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Parse a k6 JSON summary file into a K6SaturationResult.
 */
export function parseK6Summary(json: any, summaryPath: string): K6SaturationResult {
  const metrics = json.metrics ?? {};

  // HTTP request duration (latency)
  const httpDuration =
    metrics['http_req_duration'] ?? metrics['http_req_duration{expected_response:true}'] ?? {};
  const durationValues = httpDuration.values ?? {};

  // Error rate — k6 uses http_req_failed counter
  const httpReqFailed = metrics['http_req_failed'] ?? {};
  const failedValues = httpReqFailed.values ?? {};
  const errorRate = typeof failedValues.rate === 'number' ? failedValues.rate : 0;

  // Request rate (iterations per second as proxy for RPS)
  const httpReqs = metrics['http_reqs'] ?? {};
  const reqsValues = httpReqs.values ?? {};
  const rps = typeof reqsValues.rate === 'number' ? reqsValues.rate : 0;

  // VUs
  const vus = metrics['vus_max'] ?? metrics['vus'] ?? {};
  const vusValues = vus.values ?? {};
  const maxVUs =
    typeof vusValues.max === 'number'
      ? vusValues.max
      : typeof vusValues.value === 'number'
        ? vusValues.value
        : 0;

  // Duration
  const stateMeta = json.state ?? {};
  const testDurationMs =
    typeof stateMeta.testRunDurationMs === 'number' ? stateMeta.testRunDurationMs : 0;

  // Root-level timestamps
  const rootData = json.root_group ?? {};
  const startTime = rootData.start_time ?? json.start_time ?? new Date().toISOString();
  const endTime = rootData.end_time ?? json.end_time ?? new Date().toISOString();

  return {
    latency: {
      p50Ms: typeof durationValues.med === 'number' ? durationValues.med : 0,
      p95Ms: typeof durationValues['p(95)'] === 'number' ? durationValues['p(95)'] : 0,
      p99Ms: typeof durationValues['p(99)'] === 'number' ? durationValues['p(99)'] : 0,
      minMs: typeof durationValues.min === 'number' ? durationValues.min : 0,
      maxMs: typeof durationValues.max === 'number' ? durationValues.max : 0,
    },
    errorRate,
    rps,
    maxVUs,
    durationMs: testDurationMs,
    timestamps: {
      start: typeof startTime === 'string' ? startTime : new Date().toISOString(),
      end: typeof endTime === 'string' ? endTime : new Date().toISOString(),
    },
    summaryPath,
  };
}

/**
 * Run a k6 saturation test and return parsed results.
 */
export async function runK6Saturation(opts: K6RunOptions): Promise<K6SaturationResult> {
  const scriptFullPath = join(opts.benchmarksDir, opts.scriptPath);
  const startTime = new Date().toISOString();

  const env: Record<string, string> = {
    ...process.env,
    TARGET_URL: opts.targetUrl,
    K6_SUMMARY_EXPORT: opts.summaryOutputPath,
    ...(opts.env ?? {}),
  } as Record<string, string>;

  await execFile(
    'k6',
    [
      'run',
      '--summary-export',
      opts.summaryOutputPath,
      '--duration',
      `${opts.maxDurationSeconds}s`,
      scriptFullPath,
    ],
    {
      env,
      timeout: (opts.maxDurationSeconds + 60) * 1000,
      maxBuffer: 50 * 1024 * 1024,
    },
  );

  const endTime = new Date().toISOString();

  const summaryRaw = await readFile(opts.summaryOutputPath, 'utf-8');
  const summaryJson = JSON.parse(summaryRaw);

  const result = parseK6Summary(summaryJson, opts.summaryOutputPath);

  // Ensure timestamps are set if not in the summary
  if (!result.timestamps.start || result.timestamps.start === new Date(0).toISOString()) {
    result.timestamps.start = startTime;
  }
  if (!result.timestamps.end || result.timestamps.end === new Date(0).toISOString()) {
    result.timestamps.end = endTime;
  }

  return result;
}
