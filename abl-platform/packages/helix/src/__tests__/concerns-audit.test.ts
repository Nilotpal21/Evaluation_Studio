import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runConcernsAudit, walkRepoFiles, runGrepDetector } from '../concerns/index.js';
import type { Concern, GrepDetector } from '../concerns/index.js';

const BY = 'By';
const FIND_BY_ID_CALL = `.find${BY}Id(`;
const FIND_BY_ID_DELETE_CALL = `.find${BY}IdAndDelete(`;

const CONCERN_FINDBYID = `
id: tenant-isolation
title: Tenant Isolation
enforcement: blocking
severity_default: critical
rubric_concern: 1
scope:
  globs:
    - apps/**/src/**/*.ts
  exclude:
    - '**/__tests__/**'
detectors:
  - id: no-find-by-id
    kind: grep
    severity: critical
    pattern: '\\.findById\\('
    message: 'use findOne with tenantId filter'
    fix_hint: 'use findOne({_id, tenantId})'
`;

const CONCERN_MODEL_ONLY = `
id: docs-drift
title: Docs drift
enforcement: advisory
severity_default: medium
rubric_concern: 15
scope:
  globs:
    - docs/**/*.md
detectors:
  - id: docs-vs-code
    kind: model-review
    message: 'check docs vs code'
    guidance_ref: prompts/docs-drift-lens.md
    output_schema:
      rule_id: docs-vs-code
      severity: medium
      location:
        file: string
        line: number
      claim: string
      reality: string
      options:
        A: update docs
        B: update code
`;

async function seedConcern(
  rootDir: string,
  tier: 'enforced' | 'advisory',
  filename: string,
  body: string,
): Promise<void> {
  const dir = join(rootDir, '.helix/concerns', tier);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), body, 'utf8');
}

async function seedFile(rootDir: string, relPath: string, body: string): Promise<void> {
  const abs = join(rootDir, relPath);
  const lastSep = abs.lastIndexOf('/');
  if (lastSep > 0) {
    await mkdir(abs.slice(0, lastSep), { recursive: true });
  }
  await writeFile(abs, body, 'utf8');
}

describe('walkRepoFiles', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-walk-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns forward-slash repo-relative paths', async () => {
    await seedFile(tempDir, 'apps/studio/src/index.ts', 'export {};\n');
    await seedFile(tempDir, 'packages/helix/src/cli.ts', 'export {};\n');

    const files = await walkRepoFiles({ repoRoot: tempDir });
    files.sort();

    expect(files).toEqual(['apps/studio/src/index.ts', 'packages/helix/src/cli.ts']);
  });

  it('skips the default ignore directories', async () => {
    await seedFile(tempDir, 'apps/studio/src/index.ts', 'export {};\n');
    await seedFile(tempDir, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
    await seedFile(tempDir, '.git/HEAD', 'ref: refs/heads/main\n');
    await seedFile(tempDir, 'dist/index.js', 'export {};\n');
    await seedFile(tempDir, '.helix/sessions/abc/session.json', '{}\n');

    const files = await walkRepoFiles({ repoRoot: tempDir });

    expect(files).toEqual(['apps/studio/src/index.ts']);
  });

  it('honors a custom maxFiles cap', async () => {
    for (let i = 0; i < 10; i++) {
      await seedFile(tempDir, `src/file-${i}.ts`, 'export {};\n');
    }

    const files = await walkRepoFiles({ repoRoot: tempDir, maxFiles: 4 });

    expect(files.length).toBe(4);
  });
});

describe('runGrepDetector', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-grep-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('emits one finding per match with line numbers', async () => {
    await seedFile(
      tempDir,
      'apps/runtime/src/routes/user.ts',
      [
        "import { User } from './model';",
        '',
        'export async function get(id: string) {',
        `  return User${FIND_BY_ID_CALL}id);`,
        '}',
        '',
        'export async function remove(id: string) {',
        `  await User${FIND_BY_ID_DELETE_CALL}id);`,
        '}',
        '',
      ].join('\n'),
    );

    const concern = {
      id: 'tenant-isolation',
      title: 'Tenant Isolation',
      enforcement: 'blocking',
      severityDefault: 'critical',
      rubricConcern: 1,
      scope: { globs: ['apps/**/src/**/*.ts'] },
      detectors: [],
      sourcePath: join(tempDir, '.helix/concerns/enforced/tenant-isolation.yaml'),
    } as unknown as Concern;

    const detector: GrepDetector = {
      id: 'no-find-by-id',
      kind: 'grep',
      severity: 'critical',
      message: 'use findOne with tenantId filter',
      fixHint: 'use findOne({_id, tenantId})',
      pattern: '\\.findById\\(',
    };

    const findings = await runGrepDetector(
      detector,
      concern,
      ['apps/runtime/src/routes/user.ts'],
      tempDir,
    );

    expect(findings.length).toBe(1);
    const [finding] = findings;
    expect(finding.concernId).toBe('tenant-isolation');
    expect(finding.detectorId).toBe('no-find-by-id');
    expect(finding.severity).toBe('critical');
    expect(finding.file).toBe('apps/runtime/src/routes/user.ts');
    expect(finding.line).toBe(4);
    expect(finding.matchedText).toBe(FIND_BY_ID_CALL);
    expect(finding.rubricConcern).toBe(1);
    expect(finding.enforcement).toBe('blocking');
  });

  it('honors per-detector glob narrowing', async () => {
    await seedFile(tempDir, 'apps/runtime/e2e/foo.ts', "import { x } from 'mongoose';\n");
    await seedFile(tempDir, 'apps/runtime/src/routes/user.ts', "import { x } from 'mongoose';\n");

    const concern = {
      id: 'test-integrity',
      title: 'Test Integrity',
      enforcement: 'blocking',
      severityDefault: 'high',
      rubricConcern: 16,
      scope: { globs: ['apps/**/*.ts'] },
      detectors: [],
      sourcePath: 'n/a',
    } as unknown as Concern;

    const detector: GrepDetector = {
      id: 'no-mongoose-e2e',
      kind: 'grep',
      severity: 'high',
      message: 'E2E must not import mongoose',
      pattern: 'from [\'"]mongoose[\'"]',
      glob: 'apps/**/e2e/**/*.ts',
    };

    const findings = await runGrepDetector(
      detector,
      concern,
      ['apps/runtime/e2e/foo.ts', 'apps/runtime/src/routes/user.ts'],
      tempDir,
    );

    expect(findings.length).toBe(1);
    expect(findings[0].file).toBe('apps/runtime/e2e/foo.ts');
  });

  it('uses the concern severity default when the detector omits severity', async () => {
    await seedFile(tempDir, 'src/foo.ts', 'TODO: fix me\n');

    const concern = {
      id: 'fake',
      title: 'Fake',
      enforcement: 'advisory',
      severityDefault: 'medium',
      scope: { globs: ['src/**/*.ts'] },
      detectors: [],
      sourcePath: 'n/a',
    } as unknown as Concern;

    const detector: GrepDetector = {
      id: 'todo',
      kind: 'grep',
      message: 'No TODOs',
      pattern: 'TODO',
    };

    const findings = await runGrepDetector(detector, concern, ['src/foo.ts'], tempDir);

    expect(findings[0].severity).toBe('medium');
  });
});

describe('runConcernsAudit', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-audit-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('emits findings for a real violation in a scoped file', async () => {
    await seedConcern(tempDir, 'enforced', 'tenant-isolation.yaml', CONCERN_FINDBYID);
    await seedFile(
      tempDir,
      'apps/runtime/src/routes/user.ts',
      `return User${FIND_BY_ID_CALL}id);\n`,
    );
    await seedFile(
      tempDir,
      'apps/runtime/src/__tests__/user.test.ts',
      `return User${FIND_BY_ID_CALL}id);\n`,
    );

    const result = await runConcernsAudit({ repoRoot: tempDir, write: false });

    expect(result.summary.findings).toBe(1);
    expect(result.summary.blockingFindings).toBe(1);
    expect(result.summary.concernsScanned).toBe(1);
    expect(result.findings[0].file).toBe('apps/runtime/src/routes/user.ts');
    expect(result.findings[0].rubricConcern).toBe(1);
  });

  it('records model-review detectors as skipped with a clear reason', async () => {
    await seedConcern(tempDir, 'advisory', 'docs-drift.yaml', CONCERN_MODEL_ONLY);
    await seedFile(tempDir, 'docs/guide.md', '# guide\n');

    const result = await runConcernsAudit({ repoRoot: tempDir, write: false });

    expect(result.summary.findings).toBe(0);
    expect(result.summary.detectorsRun).toBe(0);
    expect(result.summary.detectorsSkipped).toBe(1);
    expect(result.skipped[0].kind).toBe('model-review');
    expect(result.skipped[0].reason).toContain('oracle-analysis');
  });

  it('writes findings JSONL and summary JSON to the output directory', async () => {
    await seedConcern(tempDir, 'enforced', 'tenant-isolation.yaml', CONCERN_FINDBYID);
    await seedFile(
      tempDir,
      'apps/runtime/src/routes/user.ts',
      `return User${FIND_BY_ID_CALL}id);\n`,
    );
    const outputDir = join(tempDir, 'out');

    const result = await runConcernsAudit({ repoRoot: tempDir, outputDir });

    expect(result.findingsPath).toBeTruthy();
    expect(result.summaryPath).toBeTruthy();

    const latestJsonl = await readFile(join(outputDir, 'findings-latest.jsonl'), 'utf8');
    const latestSummary = await readFile(join(outputDir, 'summary-latest.json'), 'utf8');

    const firstFinding = JSON.parse(latestJsonl.split('\n')[0]);
    expect(firstFinding.concernId).toBe('tenant-isolation');
    expect(firstFinding.file).toBe('apps/runtime/src/routes/user.ts');

    const summaryDoc = JSON.parse(latestSummary);
    expect(summaryDoc.summary.findings).toBe(1);
    expect(summaryDoc.summary.blockingFindings).toBe(1);
  });

  it('filters by tier and by concern id', async () => {
    await seedConcern(tempDir, 'enforced', 'tenant-isolation.yaml', CONCERN_FINDBYID);
    await seedConcern(tempDir, 'advisory', 'docs-drift.yaml', CONCERN_MODEL_ONLY);
    await seedFile(
      tempDir,
      'apps/runtime/src/routes/user.ts',
      `return User${FIND_BY_ID_CALL}id);\n`,
    );

    const blockingOnly = await runConcernsAudit({
      repoRoot: tempDir,
      write: false,
      filterTiers: ['blocking'],
    });
    expect(blockingOnly.summary.findings).toBe(1);
    expect(blockingOnly.skipped.length).toBe(0);

    const advisoryOnly = await runConcernsAudit({
      repoRoot: tempDir,
      write: false,
      filterTiers: ['advisory'],
    });
    expect(advisoryOnly.summary.findings).toBe(0);
    expect(advisoryOnly.skipped.length).toBe(1);

    const onlyTenant = await runConcernsAudit({
      repoRoot: tempDir,
      write: false,
      filterConcernIds: ['tenant-isolation'],
    });
    expect(onlyTenant.summary.findings).toBe(1);
    expect(onlyTenant.skipped.length).toBe(0);
  });

  it('returns zero findings on a clean repo and writes an empty JSONL', async () => {
    await seedConcern(tempDir, 'enforced', 'tenant-isolation.yaml', CONCERN_FINDBYID);
    await seedFile(
      tempDir,
      'apps/runtime/src/routes/user.ts',
      'return User.findOne({ _id: id, tenantId });\n',
    );

    const result = await runConcernsAudit({ repoRoot: tempDir });

    expect(result.summary.findings).toBe(0);
    expect(result.summary.blockingFindings).toBe(0);
    expect(result.findingsPath).toBeTruthy();
    const body = await readFile(result.findingsPath!, 'utf8');
    expect(body).toBe('');
  });
});

describe('seed registry audit in this repo', () => {
  it('runs against the real .helix/concerns without crashing', async () => {
    const repoRoot = join(__dirname, '..', '..', '..', '..');
    const result = await runConcernsAudit({ repoRoot, write: false });

    expect(result.loadErrors).toEqual([]);
    expect(result.summary.concernsTotal).toBe(26);
    expect(result.summary.filesScanned).toBeGreaterThan(0);
    expect(result.summary.detectorsRun).toBeGreaterThan(0);
    expect(result.summary.concernsScanned).toBeGreaterThan(0);
    // Seed concerns cover model-review detectors too — confirm they are skipped
    // with an oracle-analysis reason rather than silently run.
    const oracleSkipped = result.skipped.filter((s) => s.kind === 'model-review');
    expect(oracleSkipped.length).toBeGreaterThan(0);
    for (const skip of oracleSkipped) {
      expect(skip.reason).toContain('oracle-analysis');
    }
  });
});
