/**
 * k6 Runner Tests
 *
 * Tests the k6 summary parser with fixture data.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { parseK6Summary } from '../../../commands/benchmark/k6-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixturePath = join(__dirname, 'fixtures', 'k6-summary.json');
const fixtureJson = JSON.parse(readFileSync(fixturePath, 'utf-8'));

describe('parseK6Summary', () => {
  it('should parse latency metrics from fixture', () => {
    const result = parseK6Summary(fixtureJson, '/tmp/summary.json');

    expect(result.latency.p50Ms).toBe(38.5);
    expect(result.latency.p95Ms).toBe(250.7);
    expect(result.latency.p99Ms).toBe(510.2);
    expect(result.latency.minMs).toBe(2.1);
    expect(result.latency.maxMs).toBe(890.3);
  });

  it('should parse error rate', () => {
    const result = parseK6Summary(fixtureJson, '/tmp/summary.json');

    expect(result.errorRate).toBe(0.005);
  });

  it('should parse RPS', () => {
    const result = parseK6Summary(fixtureJson, '/tmp/summary.json');

    expect(result.rps).toBe(166.7);
  });

  it('should parse max VUs', () => {
    const result = parseK6Summary(fixtureJson, '/tmp/summary.json');

    expect(result.maxVUs).toBe(50);
  });

  it('should parse test duration', () => {
    const result = parseK6Summary(fixtureJson, '/tmp/summary.json');

    expect(result.durationMs).toBe(60000);
  });

  it('should set the summary path', () => {
    const result = parseK6Summary(fixtureJson, '/custom/path.json');

    expect(result.summaryPath).toBe('/custom/path.json');
  });

  it('should handle missing metrics gracefully', () => {
    const emptyJson = { metrics: {} };
    const result = parseK6Summary(emptyJson, '/tmp/empty.json');

    expect(result.latency.p50Ms).toBe(0);
    expect(result.latency.p95Ms).toBe(0);
    expect(result.errorRate).toBe(0);
    expect(result.rps).toBe(0);
    expect(result.maxVUs).toBe(0);
  });

  it('should handle completely empty input', () => {
    const result = parseK6Summary({}, '/tmp/none.json');

    expect(result.latency.p50Ms).toBe(0);
    expect(result.errorRate).toBe(0);
    expect(result.rps).toBe(0);
  });

  it('should provide timestamps', () => {
    const result = parseK6Summary(fixtureJson, '/tmp/summary.json');

    expect(result.timestamps.start).toBeTruthy();
    expect(result.timestamps.end).toBeTruthy();
  });
});
