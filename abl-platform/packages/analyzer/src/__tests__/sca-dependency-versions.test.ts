import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const readWorkspaceFile = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

const readJsonFile = <T>(path: string): T => JSON.parse(readWorkspaceFile(path)) as T;

interface PackageLock {
  packages?: Record<string, { version?: string }>;
}

interface DependencyRequirement {
  name: string;
  version: string;
}

const parseUvLockPackages = (path: string): Map<string, string[]> => {
  const packages = new Map<string, string[]>();
  const packageBlocks = readWorkspaceFile(path).split(/\n(?=\[\[package\]\]\n)/);

  for (const block of packageBlocks) {
    const name = block.match(/^name = "([^"]+)"/m)?.[1];
    const version = block.match(/^version = "([^"]+)"/m)?.[1];

    if (!name || !version) {
      continue;
    }

    packages.set(name, [...(packages.get(name) ?? []), version]);
  }

  return packages;
};

const parsePnpmLockVersions = (
  path: string,
  { includeDevOnly = false } = {},
): Map<string, string[]> => {
  const versions = new Map<string, string[]>();
  const lockfile = readWorkspaceFile(path);
  // Split into per-package blocks so we can inspect each block's dev: true flag.
  // Each block starts at a line matching "  /name@version:".
  const blocks = lockfile.split(/(?=\n  \/(?:@[^/\n]+\/)?[^@\n]+@[^:\n]+:)/);

  for (const block of blocks) {
    const headerMatch = block.match(/\n  \/((?:@[^/\n]+\/)?[^@\n]+)@([^:\n]+):/);

    if (!headerMatch) {
      continue;
    }

    const [, name, version] = headerMatch;
    const isDevOnly = /\n\s{4}dev:\s+true/.test(block);

    if (isDevOnly && !includeDevOnly) {
      continue;
    }

    versions.set(name, [...(versions.get(name) ?? []), version]);
  }

  return versions;
};

const parsePackageLockVersions = (path: string): Map<string, string[]> => {
  const lockfile = readJsonFile<PackageLock>(path);
  const versions = new Map<string, string[]>();

  for (const [location, metadata] of Object.entries(lockfile.packages ?? {})) {
    const packageName = location.split('node_modules/').pop();

    if (!packageName || !metadata.version) {
      continue;
    }

    versions.set(packageName, [...(versions.get(packageName) ?? []), metadata.version]);
  }

  return versions;
};

const parseGoModVersions = (path: string): Map<string, string> => {
  const versions = new Map<string, string>();
  const moduleLine = /^\s*([^\s]+)\s+v([^\s]+)(?:\s+\/\/.*)?$/gm;

  for (const match of readWorkspaceFile(path).matchAll(moduleLine)) {
    const [, name, version] = match;
    versions.set(name, version);
  }

  return versions;
};

const parseRequirementsVersions = (path: string): Map<string, string> => {
  const versions = new Map<string, string>();

  for (const line of readWorkspaceFile(path).split('\n')) {
    const match = line.trim().match(/^([A-Za-z0-9_.-]+)==([^#\s]+)/);

    if (match) {
      versions.set(match[1].toLowerCase(), match[2]);
    }
  }

  return versions;
};

const expectOnlyLockedVersion = (
  versions: Map<string, string[]>,
  requirement: DependencyRequirement,
  sourceFile: string,
): void => {
  expect(versions.get(requirement.name), `${sourceFile} should lock ${requirement.name}`).toEqual([
    requirement.version,
  ]);
};

describe('ABLP-676 SCA dependency version contract', () => {
  test('uv lockfiles pin the patched Python package versions', () => {
    const expectedByLockfile: Record<string, DependencyRequirement[]> = {
      'services/docling-service/uv.lock': [
        { name: 'nltk', version: '3.9.4' },
        { name: 'lxml', version: '6.1.0' },
        { name: 'pillow', version: '12.2.0' },
        { name: 'aiohttp', version: '3.13.4' },
        { name: 'banks', version: '2.4.2' },
        { name: 'pypdf', version: '6.10.1' },
        { name: 'pytest', version: '9.0.3' },
        { name: 'python-dotenv', version: '1.0.0' },
        { name: 'python-multipart', version: '0.0.27' },
        { name: 'requests', version: '2.33.0' },
        { name: 'tinytag', version: '2.2.1' },
        { name: 'transformers', version: '5.0.0rc3' },
        { name: 'urllib3', version: '2.7.0' },
      ],
      'services/preprocessing-service/uv.lock': [
        { name: 'nltk', version: '3.9.4' },
        { name: 'black', version: '26.3.1' },
        { name: 'gunicorn', version: '22.0.0' },
        { name: 'pytest', version: '9.0.3' },
        { name: 'python-dotenv', version: '1.0.0' },
      ],
    };

    for (const [lockfile, requirements] of Object.entries(expectedByLockfile)) {
      const versions = parseUvLockPackages(lockfile);

      for (const requirement of requirements) {
        expectOnlyLockedVersion(versions, requirement, lockfile);
      }
    }
  });

  test('pnpm lockfile contains only the patched JavaScript package versions', () => {
    const versions = parsePnpmLockVersions('pnpm-lock.yaml');
    const requirements: DependencyRequirement[] = [
      { name: '@xmldom/xmldom', version: '0.8.13' },
      { name: 'basic-ftp', version: '5.3.1' },
      { name: 'ajv', version: '8.18.0' },
      { name: 'fast-xml-parser', version: '5.7.0' },
      { name: 'markdown-it', version: '14.1.1' },
      { name: 'postcss', version: '8.5.10' },
      { name: 'uuid', version: '14.0.0' },
    ];

    for (const requirement of requirements) {
      expectOnlyLockedVersion(versions, requirement, 'pnpm-lock.yaml');
    }
  });

  test('legacy package-lock files contain only the patched JavaScript package versions', () => {
    const lockfiles = [
      'packages/core/package-lock.json',
      'packages/compiler/package-lock.json',
      'packages/analyzer/package-lock.json',
      'packages/nl-parser/package-lock.json',
    ];
    const requirements: DependencyRequirement[] = [
      { name: 'lodash-es', version: '4.18.0' },
      { name: 'minimatch', version: '10.2.1' },
      { name: 'rollup', version: '4.59.0' },
      { name: 'esbuild', version: '0.25.0' },
      { name: 'brace-expansion', version: '5.0.5' },
      { name: 'postcss', version: '8.5.10' },
    ];

    for (const lockfile of lockfiles) {
      const versions = parsePackageLockVersions(lockfile);

      for (const requirement of requirements) {
        if (versions.has(requirement.name)) {
          expectOnlyLockedVersion(versions, requirement, lockfile);
        }
      }

      const viteVersions = versions.get('vite') ?? [];

      if (viteVersions.length > 0) {
        expect(
          viteVersions,
          `${lockfile} should lock vite to one of the ABLP-676 patched release lines`,
        ).toEqual(expect.arrayContaining(['8.0.5']));
      }
    }

    expectOnlyLockedVersion(
      parsePackageLockVersions('apps/crawler-go-worker/package-lock.json'),
      { name: 'uuid', version: '14.0.0' },
      'apps/crawler-go-worker/package-lock.json',
    );
  });

  test('go.mod pins the patched Go module versions', () => {
    const versions = parseGoModVersions('apps/crawler-go-worker/go.mod');
    const requirements: DependencyRequirement[] = [
      { name: 'golang.org/x/net', version: '0.38.0' },
      { name: 'google.golang.org/protobuf', version: '1.33.0' },
      { name: 'github.com/redis/go-redis/v9', version: '9.7.3' },
    ];

    for (const requirement of requirements) {
      expect(versions.get(requirement.name), `go.mod should require ${requirement.name}`).toBe(
        requirement.version,
      );
    }
  });

  test('nlu sidecar requirements pin the patched Flask version', () => {
    const versions = parseRequirementsVersions('apps/nlu-sidecar/requirements.txt');

    expect(versions.get('flask'), 'requirements.txt should pin flask').toBe('3.1.3');
  });
});
