import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  concernsApplyingTo,
  concernsForFile,
  globToRegExp,
  loadConcernsRegistry,
  scopeMatches,
} from '../concerns/index.js';

const VALID_ENFORCED = `
id: tenant-isolation
title: Tenant Isolation
enforcement: blocking
severity_default: critical
scope:
  globs:
    - apps/**/src/**/*.ts
  exclude:
    - '**/__tests__/**'
detectors:
  - id: no-find-by-id
    kind: grep
    severity: critical
    pattern: '\\.findById\\\\('
    message: 'use findOne with tenantId filter'
    fix_hint: 'use findOne({_id, tenantId}) instead'
stage_hooks:
  - stage: implementation
    inject_checklist: true
`;

const VALID_ADVISORY = `
id: scale
title: Scale
enforcement: advisory
severity_default: medium
scope:
  globs:
    - apps/**/*.ts
detectors:
  - id: payload-size
    kind: model-review
    message: 'bound payload size at boundary'
    guidance_ref: prompts/scale-lens.md
    output_schema:
      rule_id: payload-size
      severity: medium
      location:
        file: string
        line: number
      claim: string
      reality: string
      options:
        A: add zod max
        B: upstream bounds it
`;

async function writeConcern(
  rootDir: string,
  tier: 'enforced' | 'advisory',
  filename: string,
  body: string,
): Promise<void> {
  const dir = join(rootDir, tier);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), body, 'utf8');
}

describe('globToRegExp', () => {
  it('matches a single-segment wildcard within a path segment', () => {
    const re = globToRegExp('apps/*/src/index.ts');
    expect(re.test('apps/studio/src/index.ts')).toBe(true);
    expect(re.test('apps/studio/deeper/src/index.ts')).toBe(false);
  });

  it('matches double-wildcard across segments', () => {
    const re = globToRegExp('apps/**/*.ts');
    expect(re.test('apps/studio/src/routes/foo.ts')).toBe(true);
    expect(re.test('apps/studio/foo.ts')).toBe(true);
    expect(re.test('packages/helix/src/foo.ts')).toBe(false);
  });

  it('anchors at both ends', () => {
    const re = globToRegExp('src/index.ts');
    expect(re.test('src/index.ts')).toBe(true);
    expect(re.test('apps/studio/src/index.ts')).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    const re = globToRegExp('foo.bar+baz');
    expect(re.test('foo.bar+baz')).toBe(true);
    expect(re.test('fooXbar+baz')).toBe(false);
  });
});

describe('scopeMatches', () => {
  const scope = {
    globs: ['apps/**/src/**/*.ts'],
    exclude: ['**/__tests__/**', '**/*.test.ts'],
  };

  it('includes matching files', () => {
    expect(scopeMatches(scope, 'apps/studio/src/routes/foo.ts')).toBe(true);
  });

  it('respects excludes', () => {
    expect(scopeMatches(scope, 'apps/studio/src/__tests__/foo.ts')).toBe(false);
    expect(scopeMatches(scope, 'apps/studio/src/foo.test.ts')).toBe(false);
  });

  it('rejects non-matching files', () => {
    expect(scopeMatches(scope, 'packages/helix/src/foo.ts')).toBe(false);
  });
});

describe('loadConcernsRegistry', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-concerns-loader-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads enforced and advisory concerns and exposes them by id', async () => {
    await writeConcern(tempDir, 'enforced', 'tenant-isolation.yaml', VALID_ENFORCED);
    await writeConcern(tempDir, 'advisory', 'scale.yaml', VALID_ADVISORY);

    const { registry, errors } = await loadConcernsRegistry({ rootDir: tempDir });

    expect(errors).toEqual([]);
    expect(registry.enforced).toHaveLength(1);
    expect(registry.advisory).toHaveLength(1);
    expect(registry.byId.get('tenant-isolation')?.title).toBe('Tenant Isolation');
    expect(registry.byId.get('scale')?.enforcement).toBe('advisory');
  });

  it('rejects blocking concerns placed in advisory/', async () => {
    await writeConcern(tempDir, 'advisory', 'tenant-isolation.yaml', VALID_ENFORCED);

    const { registry, errors } = await loadConcernsRegistry({ rootDir: tempDir });

    expect(registry.all).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('enforcement: advisory');
  });

  it('rejects a file whose id does not match its filename', async () => {
    await writeConcern(tempDir, 'enforced', 'wrong-name.yaml', VALID_ENFORCED);

    const { registry, errors } = await loadConcernsRegistry({ rootDir: tempDir });

    expect(registry.all).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('does not match filename');
  });

  it('rejects schema violations with a useful message', async () => {
    await writeConcern(
      tempDir,
      'enforced',
      'broken.yaml',
      `
id: broken
title: Broken
enforcement: blocking
severity_default: banana
scope:
  globs:
    - apps/**/*.ts
detectors:
  - id: x
    kind: grep
    pattern: foo
    message: bar
`,
    );

    const { errors } = await loadConcernsRegistry({ rootDir: tempDir });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('severity_default');
  });

  it('rejects duplicate ids across files', async () => {
    await writeConcern(tempDir, 'enforced', 'tenant-isolation.yaml', VALID_ENFORCED);
    const dupe = VALID_ADVISORY.replace('id: scale', 'id: tenant-isolation').replace(
      'enforcement: advisory',
      'enforcement: advisory',
    );
    // Rename the advisory file to match the duplicated id.
    await writeConcern(tempDir, 'advisory', 'tenant-isolation.yaml', dupe);

    const { errors } = await loadConcernsRegistry({ rootDir: tempDir });

    expect(errors.some((e) => e.message.includes('duplicate concern id'))).toBe(true);
  });

  it('returns empty registry when no concerns are present', async () => {
    const { registry, errors } = await loadConcernsRegistry({ rootDir: tempDir });
    expect(errors).toEqual([]);
    expect(registry.all).toEqual([]);
  });
});

describe('concernsApplyingTo and concernsForFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-concerns-apply-'));
    await writeConcern(tempDir, 'enforced', 'tenant-isolation.yaml', VALID_ENFORCED);
    await writeConcern(tempDir, 'advisory', 'scale.yaml', VALID_ADVISORY);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('selects concerns whose scope matches any changed file', async () => {
    const { registry } = await loadConcernsRegistry({ rootDir: tempDir });
    const applying = concernsApplyingTo(registry.all, [
      'apps/studio/src/routes/foo.ts',
      'README.md',
    ]);
    expect(applying.map((c) => c.id).sort()).toEqual(['scale', 'tenant-isolation']);
  });

  it('selects no concerns when no file matches', async () => {
    const { registry } = await loadConcernsRegistry({ rootDir: tempDir });
    const applying = concernsApplyingTo(registry.all, ['docs/README.md']);
    expect(applying).toEqual([]);
  });

  it('returns applicable concerns for a single file', async () => {
    const { registry } = await loadConcernsRegistry({ rootDir: tempDir });
    const hits = concernsForFile(registry.all, 'apps/studio/src/routes/foo.ts');
    expect(hits.map((c) => c.id).sort()).toEqual(['scale', 'tenant-isolation']);
  });
});

describe('rubric fields round-trip through the loader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-concerns-rubric-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('parses rubric_concern and narrative sections into camelCase fields', async () => {
    const body = `
id: tenant-isolation
title: Tenant Isolation
enforcement: blocking
severity_default: critical
rubric_concern: 1
protects:
  - tenant and project isolation
  - non-leaky access behavior
review_when:
  - routes or middleware change
review_questions:
  - Does every read carry tenant scope?
proof_expected:
  - scoped query filters
  - allow-path and deny-path tests
scope:
  globs:
    - apps/**/src/**/*.ts
detectors:
  - id: x
    kind: grep
    pattern: 'findById'
    message: 'use findOne'
`;
    await writeConcern(tempDir, 'enforced', 'tenant-isolation.yaml', body);

    const { registry, errors } = await loadConcernsRegistry({ rootDir: tempDir });
    expect(errors).toEqual([]);
    const concern = registry.byId.get('tenant-isolation');
    expect(concern?.rubricConcern).toBe(1);
    expect(concern?.protects).toEqual([
      'tenant and project isolation',
      'non-leaky access behavior',
    ]);
    expect(concern?.reviewWhen).toEqual(['routes or middleware change']);
    expect(concern?.reviewQuestions).toEqual(['Does every read carry tenant scope?']);
    expect(concern?.proofExpected).toEqual([
      'scoped query filters',
      'allow-path and deny-path tests',
    ]);
  });

  it('accepts concerns without rubric fields (optional)', async () => {
    await writeConcern(tempDir, 'enforced', 'tenant-isolation.yaml', VALID_ENFORCED);
    const { registry, errors } = await loadConcernsRegistry({ rootDir: tempDir });
    expect(errors).toEqual([]);
    const concern = registry.byId.get('tenant-isolation');
    expect(concern?.rubricConcern).toBeUndefined();
    expect(concern?.protects).toBeUndefined();
  });

  it('rejects rubric_concern outside 1–16', async () => {
    const bad = VALID_ENFORCED.replace(
      'severity_default: critical\n',
      'severity_default: critical\nrubric_concern: 42\n',
    );
    await writeConcern(tempDir, 'enforced', 'tenant-isolation.yaml', bad);
    const { errors } = await loadConcernsRegistry({ rootDir: tempDir });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('rubric_concern');
  });
});

describe('seed registry in this repo', () => {
  it('loads every seed concern from .helix/concerns without errors', async () => {
    const repoRoot = join(__dirname, '..', '..', '..', '..');
    const { registry, errors } = await loadConcernsRegistry({ repoRoot });
    expect(errors).toEqual([]);
    expect(registry.enforced.length).toBe(16);
    expect(registry.advisory.length).toBe(10);
    expect(registry.all.length).toBe(26);
  });

  it('every seed concern declares a rubric_concern in 1..16', async () => {
    const repoRoot = join(__dirname, '..', '..', '..', '..');
    const { registry } = await loadConcernsRegistry({ repoRoot });
    const missing = registry.all.filter((c) => c.rubricConcern === undefined);
    expect(missing.map((c) => c.id)).toEqual([]);
    for (const concern of registry.all) {
      expect(concern.rubricConcern).toBeGreaterThanOrEqual(1);
      expect(concern.rubricConcern).toBeLessThanOrEqual(16);
    }
  });

  it('every rubric concern (1..16) has at least one seed YAML covering it', async () => {
    const repoRoot = join(__dirname, '..', '..', '..', '..');
    const { registry } = await loadConcernsRegistry({ repoRoot });
    const covered = new Set(registry.all.map((c) => c.rubricConcern));
    const uncovered: number[] = [];
    for (let i = 1; i <= 16; i++) {
      if (!covered.has(i as never)) uncovered.push(i);
    }
    expect(uncovered).toEqual([]);
  });
});
