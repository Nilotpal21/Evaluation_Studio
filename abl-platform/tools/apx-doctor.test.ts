import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseApxDoctorArgs, shouldExitNonZero } from './apx-doctor.js';
import {
  blockHasPath,
  extractTopLevelYamlBlock,
  formatApxDoctorReport,
  parseEnvText,
  runApxDoctor,
  type ApxDoctorProgressEvent,
  type ApxDoctorReport,
} from './apx-doctor-lib.js';

test('parseEnvText strips inline comments without damaging literal hashes', () => {
  const parsed = parseEnvText(
    [
      '# comment',
      'export JWT_SECRET="secret value" # shared across services',
      "WORKFLOW_ENGINE_URL='https://workflow.example.internal' # comment",
      'TAG=release#candidate',
      'EMPTY=',
    ].join('\n'),
  );

  assert.equal(parsed.JWT_SECRET, 'secret value');
  assert.equal(parsed.WORKFLOW_ENGINE_URL, 'https://workflow.example.internal');
  assert.equal(parsed.TAG, 'release#candidate');
  assert.equal(parsed.EMPTY, '');
});

test('extractTopLevelYamlBlock and blockHasPath detect probe coverage', () => {
  const yaml = [
    'runtime:',
    '  image: runtime:latest',
    '  probes:',
    '    liveness:',
    '      path: /health',
    '    readiness:',
    '      path: /health/ready',
    'searchAi:',
    '  image: search-ai:latest',
    '  probes:',
    '    liveness:',
    '      path: /health',
  ].join('\n');

  const runtimeBlock = extractTopLevelYamlBlock(yaml, 'runtime');
  const searchAiBlock = extractTopLevelYamlBlock(yaml, 'searchAi');

  assert.ok(runtimeBlock);
  assert.ok(searchAiBlock);
  assert.equal(blockHasPath(runtimeBlock!, ['probes', 'liveness']), true);
  assert.equal(blockHasPath(runtimeBlock!, ['probes', 'readiness']), true);
  assert.equal(blockHasPath(searchAiBlock!, ['probes', 'readiness']), false);
});

test('parseApxDoctorArgs accepts supported flags and values', () => {
  const parsed = parseApxDoctorArgs([
    '--json',
    '--no-live',
    '--strict',
    '--timeout-ms',
    '9000',
    '--root=./apps/runtime',
  ]);

  assert.deepEqual(parsed, {
    help: false,
    json: true,
    live: false,
    rootDir: './apps/runtime',
    strict: true,
    timeoutMs: 9000,
  });
});

test('parseApxDoctorArgs rejects invalid timeout values', () => {
  assert.throws(
    () => parseApxDoctorArgs(['--timeout-ms', 'abc']),
    /Invalid --timeout-ms value: abc/,
  );
});

test('shouldExitNonZero respects fail and strict warning semantics', () => {
  const baseReport: ApxDoctorReport = {
    generatedAt: '2026-04-20T00:00:00.000Z',
    repoPath: '/repo',
    summary: {
      status: 'pass',
      counts: { pass: 1, warn: 0, fail: 0, skip: 0 },
      byCategory: {
        configuration: { pass: 1, warn: 0, fail: 0, skip: 0 },
        deployment: { pass: 0, warn: 0, fail: 0, skip: 0 },
        integration: { pass: 0, warn: 0, fail: 0, skip: 0 },
        health: { pass: 0, warn: 0, fail: 0, skip: 0 },
      },
    },
    checks: [],
    nextActions: [],
  };

  assert.equal(shouldExitNonZero(baseReport, false), false);
  assert.equal(
    shouldExitNonZero(
      {
        ...baseReport,
        summary: {
          ...baseReport.summary,
          status: 'warn',
          counts: { pass: 0, warn: 1, fail: 0, skip: 0 },
        },
      },
      false,
    ),
    false,
  );
  assert.equal(
    shouldExitNonZero(
      {
        ...baseReport,
        summary: {
          ...baseReport.summary,
          status: 'warn',
          counts: { pass: 0, warn: 1, fail: 0, skip: 0 },
        },
      },
      true,
    ),
    true,
  );
  assert.equal(
    shouldExitNonZero(
      {
        ...baseReport,
        summary: {
          ...baseReport.summary,
          status: 'fail',
          counts: { pass: 0, warn: 0, fail: 1, skip: 0 },
        },
      },
      false,
    ),
    true,
  );
});

test('runApxDoctor emits phase and probe progress events', async () => {
  await withTempDir(async (rootDir) => {
    const events: ApxDoctorProgressEvent[] = [];
    const report = await runApxDoctor({
      rootDir,
      live: false,
      onProgress: (event) => events.push(event),
    });

    assert.ok(events.length > 0);
    assert.deepEqual(events[0], {
      type: 'phase-start',
      category: 'configuration',
      label: 'Configuration',
    });
    assert.ok(
      events.some(
        (event) =>
          event.type === 'phase-complete' && event.category === 'health' && event.counts.skip > 0,
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === 'probe-progress' &&
          event.category === 'integration' &&
          event.status === 'skip',
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === 'probe-progress' && event.category === 'health' && event.status === 'skip',
      ),
    );
    assert.ok(report.summary.counts.skip > 0);
  });
});

test('runApxDoctor treats env-only provisioning as ready when required keys resolve', async () => {
  await withTempDir(async (rootDir) => {
    await withEnv(
      {
        MONGODB_URL: 'mongodb://localhost:27017/agent-platform',
        JWT_SECRET: 'super-secret-jwt-value',
        AUTH_SDK_SESSION_SIGNING_SECRET: 'session-secret',
        AUTH_SDK_BOOTSTRAP_SIGNING_SECRET: 'bootstrap-secret',
        WORKFLOW_ENGINE_URL: 'http://workflow.example.internal',
        RUNTIME_URL: 'http://runtime.example.internal',
      },
      async () => {
        const report = await runApxDoctor({ rootDir, live: false });
        const check = getCheck(report, 'configuration.runtime.env-provisioning');

        assert.equal(check.status, 'pass');
        assert.ok(
          check.evidence.includes(
            'No local env file detected; falling back to current process environment only.',
          ),
        );
      },
    );
  });
});

test('runApxDoctor does not require ENCRYPTION_MASTER_KEY when encryption is disabled', async () => {
  await withTempDir(async (rootDir) => {
    await withEnv(
      {
        ENCRYPTION_ENABLED: 'false',
        ENCRYPTION_MASTER_KEY: undefined,
        MONGODB_URL: 'mongodb://localhost:27017/agent-platform',
        REDIS_URL: 'redis://localhost:6379',
        RESTATE_INGRESS_URL: 'http://workflow-restate.example.internal',
        JWT_SECRET: 'super-secret-jwt-value',
        RUNTIME_URL: 'http://runtime.example.internal',
      },
      async () => {
        const report = await runApxDoctor({ rootDir, live: false });
        const workflowCheck = getCheck(report, 'configuration.workflow-engine.env-provisioning');
        const sharedKeyCheck = getCheck(report, 'shared.encryption-key');
        const qualityCheck = getCheck(report, 'configuration.encryption-key-quality');

        assert.equal(workflowCheck.status, 'pass');
        assert.ok(
          workflowCheck.evidence.includes(
            'ENCRYPTION_MASTER_KEY not required because ENCRYPTION_ENABLED=false.',
          ),
        );
        assert.equal(sharedKeyCheck.status, 'pass');
        assert.match(
          sharedKeyCheck.evidence[0] ?? '',
          /not required because encryption is disabled/i,
        );
        assert.equal(qualityCheck.status, 'pass');
        assert.match(
          qualityCheck.evidence[0] ?? '',
          /not required because encryption is disabled/i,
        );
      },
    );
  });
});

test('runApxDoctor honors RESTATE_INGRESS_URL for live restate health checks', async () => {
  await withTempDir(async (rootDir) => {
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });

    await new Promise<void>((resolveServer) => {
      server.listen(0, '127.0.0.1', () => resolveServer());
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const baseUrl = `http://127.0.0.1:${address.port}`;

      await withEnv(
        {
          RESTATE_ADMIN_URL: undefined,
          RESTATE_INGRESS_URL: baseUrl,
          RESTATE_URL: undefined,
        },
        async () => {
          const report = await runApxDoctor({
            rootDir,
            live: true,
            timeoutMs: 250,
          });
          const check = getCheck(report, 'health.restate-health');

          assert.equal(check.status, 'pass');
          assert.ok(
            check.evidence.some((entry) => entry.includes(`${baseUrl}/health -> HTTP 200`)),
          );
        },
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    }
  });
});

test('formatApxDoctorReport summarizes env evidence without dropping missing keys', () => {
  const report: ApxDoctorReport = {
    generatedAt: '2026-04-20T00:00:00.000Z',
    repoPath: '/repo',
    summary: {
      status: 'fail',
      counts: { pass: 0, warn: 0, fail: 1, skip: 0 },
      byCategory: {
        configuration: { pass: 0, warn: 0, fail: 1, skip: 0 },
        deployment: { pass: 0, warn: 0, fail: 0, skip: 0 },
        integration: { pass: 0, warn: 0, fail: 0, skip: 0 },
        health: { pass: 0, warn: 0, fail: 0, skip: 0 },
      },
    },
    checks: [
      {
        id: 'configuration.runtime.env-provisioning',
        category: 'configuration',
        title: 'Runtime environment is provisioned',
        status: 'fail',
        severity: 'critical',
        evidence: [
          'Provisioned file .env',
          'Provisioned file apps/runtime/.env',
          'Missing required key JWT_SECRET',
          'Missing required key RUNTIME_URL',
          'Missing required key WORKFLOW_ENGINE_URL',
          'Missing required key AUTH_SDK_BOOTSTRAP_SIGNING_SECRET',
        ],
        remediation: 'Populate all required keys.',
      },
    ],
    nextActions: ['Populate all required keys.'],
  };

  const lines = formatApxDoctorReport(report).join('\n');
  assert.match(lines, /Failures To Fix Now \(1\):/);
  assert.match(lines, /Configuration \/ Runtime environment provisioning/);
  assert.doesNotMatch(lines, /Findings:/);
  assert.match(lines, /Env files: \.env, apps\/runtime\/\.env/);
  assert.match(
    lines,
    /Missing keys: JWT_SECRET, RUNTIME_URL, WORKFLOW_ENGINE_URL, AUTH_SDK_BOOTSTRAP_SIGNING_SECRET/,
  );
  assert.match(lines, /Fix #1/);
  assert.match(lines, /Fix Checklist:/);
  assert.match(lines, /1\. Populate all required keys\./);
});

test('formatApxDoctorReport groups HTTP probe fixes into one checklist item', () => {
  const report: ApxDoctorReport = {
    generatedAt: '2026-04-20T00:00:00.000Z',
    repoPath: '/repo',
    summary: {
      status: 'fail',
      counts: { pass: 0, warn: 0, fail: 2, skip: 0 },
      byCategory: {
        configuration: { pass: 0, warn: 0, fail: 0, skip: 0 },
        deployment: { pass: 0, warn: 0, fail: 0, skip: 0 },
        integration: { pass: 0, warn: 0, fail: 1, skip: 0 },
        health: { pass: 0, warn: 0, fail: 1, skip: 0 },
      },
    },
    checks: [
      {
        id: 'integration.runtime-ready',
        category: 'integration',
        title: 'Runtime /health/ready is reachable',
        status: 'fail',
        severity: 'high',
        evidence: ['http://localhost:3112/health/ready unreachable', 'Error: fetch failed'],
        remediation:
          'Ensure http://localhost:3112/health/ready is up and returns a healthy response before relying on this environment.',
      },
      {
        id: 'health.studio-health',
        category: 'health',
        title: 'Studio /api/health is reachable',
        status: 'fail',
        severity: 'high',
        evidence: ['http://localhost:5173/api/health unreachable', 'Error: fetch failed'],
        remediation:
          'Ensure http://localhost:5173/api/health is up and returns a healthy response before relying on this environment.',
      },
    ],
    nextActions: [],
  };

  const lines = formatApxDoctorReport(report).join('\n');
  assert.match(
    lines,
    /1\. Bring the target HTTP health\/readiness endpoint up and return a healthy response before relying on this environment\./,
  );
  assert.doesNotMatch(lines, /2\. Bring the target HTTP health\/readiness endpoint up/);
  assert.match(lines, /Integration \/ Runtime \/health\/ready/);
  assert.match(lines, /Health \/ Studio \/api\/health/);
  assert.match(lines, /Fix #1/);
});

test('runApxDoctor surfaces change-management blockers from readiness responses', async () => {
  await withTempDir(async (rootDir) => {
    const server = createServer((req, res) => {
      if (req.url === '/health/ready') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'not_ready',
            reason: 'change_incompatible',
            changeManagement: {
              service: 'runtime',
              environment: 'dev',
              enforcementMode: 'soft_ready',
              outcome: 'not_ready',
              blockers: [
                {
                  changeId: 'seed.platform-core',
                  status: 'missing',
                  message: 'seed.platform-core is missing from change history.',
                },
                {
                  changeId: 'seed.rbac-tool-permissions',
                  status: 'missing',
                  message: 'seed.rbac-tool-permissions is missing from change history.',
                },
              ],
            },
          }),
        );
        return;
      }

      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy' }));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });

    await new Promise<void>((resolveServer) => {
      server.listen(0, '127.0.0.1', () => resolveServer());
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const baseUrl = `http://127.0.0.1:${address.port}`;

      await withEnv(
        {
          RUNTIME_URL: baseUrl,
        },
        async () => {
          const report = await runApxDoctor({
            rootDir,
            live: true,
            timeoutMs: 250,
          });
          const check = getCheck(report, 'integration.runtime-ready');

          assert.equal(check.status, 'fail');
          assert.ok(
            check.evidence.includes('Response status: not_ready'),
            `Expected runtime-ready evidence to include response status, got ${JSON.stringify(check.evidence)}`,
          );
          assert.ok(
            check.evidence.some((entry) =>
              entry.includes('Change blocker seed.platform-core (missing)'),
            ),
            `Expected runtime-ready evidence to include seed.platform-core blocker, got ${JSON.stringify(check.evidence)}`,
          );
          assert.ok(
            check.evidence.some((entry) =>
              entry.includes('Change blocker seed.rbac-tool-permissions (missing)'),
            ),
            `Expected runtime-ready evidence to include seed.rbac-tool-permissions blocker, got ${JSON.stringify(check.evidence)}`,
          );
        },
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    }
  });
});

async function withTempDir(run: (rootDir: string) => Promise<void>): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'apx-doctor-'));
  try {
    await run(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function withEnv(
  overrides: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }

  try {
    await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
        continue;
      }
      process.env[key] = value;
    }
  }
}

function getCheck(report: ApxDoctorReport, id: string) {
  const check = report.checks.find((entry) => entry.id === id);
  assert.ok(check, `Expected doctor check ${id} to be present`);
  return check;
}
