import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

type VersionExpectation = {
  path: string;
  packageName: string;
  minVersion: string;
  actualVersions: string[];
  required?: boolean;
};

type ForbiddenPackageExpectation = {
  path: string;
  packageName: string;
  actualVersions: string[];
};

const readWorkspaceFile = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

const compareVersions = (actual: string, minimum: string): number => {
  const parse = (version: string): number[] => {
    const normalized = version
      .replace(/^v/, '')
      .replace(/rc(\d+)$/i, '.$1')
      .split(/[.+-]/)
      .map((part) => Number.parseInt(part.replace(/\D.*/, ''), 10))
      .map((part) => (Number.isFinite(part) ? part : 0));

    return normalized;
  };

  const actualParts = parse(actual);
  const minimumParts = parse(minimum);
  const maxLength = Math.max(actualParts.length, minimumParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const actualPart = actualParts[index] ?? 0;
    const minimumPart = minimumParts[index] ?? 0;

    if (actualPart > minimumPart) {
      return 1;
    }

    if (actualPart < minimumPart) {
      return -1;
    }
  }

  return 0;
};

const formatOutdatedVersions = (expectations: VersionExpectation[]): string[] =>
  expectations.flatMap(({ path, packageName, minVersion, actualVersions }) =>
    actualVersions
      .filter((actualVersion) => compareVersions(actualVersion, minVersion) < 0)
      .map((actualVersion) => `${path}: ${packageName}@${actualVersion} < ${minVersion}`),
  );

const extractUvLockPackageVersions = (
  path: string,
  packageNames: string[],
): VersionExpectation[] => {
  const lockfile = readWorkspaceFile(path);
  const packageBlocks = lockfile.split(/\n(?=\[\[package\]\])/);

  return packageNames.map((packageName) => {
    const actualVersions = packageBlocks.flatMap((block) => {
      const nameMatch = block.match(/^name = "([^"]+)"$/m);

      if (nameMatch?.[1] !== packageName) {
        return [];
      }

      const versionMatch = block.match(/^version = "([^"]+)"$/m);
      return versionMatch?.[1] ? [versionMatch[1]] : [];
    });

    return {
      path,
      packageName,
      minVersion: uvLockMinimums[packageName],
      actualVersions,
    };
  });
};

const extractPyprojectDependencyVersions = (
  path: string,
  minimums: Record<string, string>,
): VersionExpectation[] => {
  const pyproject = readWorkspaceFile(path);

  return Object.entries(minimums).map(([packageName, minVersion]) => {
    const packagePattern = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dependencyMatch = pyproject.match(
      new RegExp(`"${packagePattern}(?:\\[[^\\]]+\\])?\\s*(?:==|>=)\\s*([^",;<\\s]+)`, 'i'),
    );

    return {
      path,
      packageName,
      minVersion,
      actualVersions: dependencyMatch?.[1] ? [dependencyMatch[1]] : [],
      required: true,
    };
  });
};

const extractRequirementVersions = (
  path: string,
  minimums: Record<string, string>,
): VersionExpectation[] => {
  const requirements = readWorkspaceFile(path);

  return Object.entries(minimums).map(([packageName, minVersion]) => {
    const packagePattern = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const requirementMatch = requirements.match(
      new RegExp(`^${packagePattern}\\s*(?:==|>=)\\s*([^\\s#]+)`, 'im'),
    );

    return {
      path,
      packageName,
      minVersion,
      actualVersions: requirementMatch?.[1] ? [requirementMatch[1]] : [],
      required: true,
    };
  });
};

const extractPnpmLockVersions = (
  path: string,
  minimums: Record<string, string>,
  { includeDevOnly = false } = {},
): VersionExpectation[] => {
  const lockfile = readWorkspaceFile(path);
  // Split into per-package blocks so we can inspect each block's dev: true flag.
  const blocks = lockfile.split(/(?=\n  \/(?:@[^/\n]+\/)?[^@\n]+@[^:\n]+:)/);

  return Object.entries(minimums).map(([packageName, minVersion]) => {
    const packagePattern = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const headerRe = new RegExp(`\\n  \\/${packagePattern}@([^:\\n]+):`);
    const actualVersions: string[] = [];

    for (const block of blocks) {
      const headerMatch = block.match(headerRe);

      if (!headerMatch) {
        continue;
      }

      const isDevOnly = /\n\s{4}dev:\s+true/.test(block);

      if (isDevOnly && !includeDevOnly) {
        continue;
      }

      actualVersions.push(headerMatch[1]);
    }

    return { path, packageName, minVersion, actualVersions };
  });
};

const extractPackageLockVersions = (
  path: string,
  minimums: Record<string, string>,
): VersionExpectation[] => {
  const packageLock = JSON.parse(readWorkspaceFile(path)) as {
    packages?: Record<string, { version?: string }>;
  };
  const packageEntries = Object.entries(packageLock.packages ?? {});

  return Object.entries(minimums).map(([packageName, minVersion]) => {
    const actualVersions = packageEntries.flatMap(([packagePath, metadata]) => {
      if (packagePath !== `node_modules/${packageName}`) {
        return [];
      }

      return metadata.version ? [metadata.version] : [];
    });

    return { path, packageName, minVersion, actualVersions };
  });
};

const extractForbiddenPackageLockVersions = (
  path: string,
  packageNames: string[],
): ForbiddenPackageExpectation[] => {
  const packageLock = JSON.parse(readWorkspaceFile(path)) as {
    packages?: Record<string, { version?: string }>;
  };
  const packageEntries = Object.entries(packageLock.packages ?? {});

  return packageNames.map((packageName) => {
    const actualVersions = packageEntries.flatMap(([packagePath, metadata]) => {
      if (packagePath !== `node_modules/${packageName}`) {
        return [];
      }

      return metadata.version ? [metadata.version] : [];
    });

    return { path, packageName, actualVersions };
  });
};

const extractGoModVersions = (
  path: string,
  minimums: Record<string, string>,
): VersionExpectation[] => {
  const goMod = readWorkspaceFile(path);

  return Object.entries(minimums).map(([packageName, minVersion]) => {
    const packagePattern = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const moduleMatch = goMod.match(new RegExp(`\\b${packagePattern}\\s+v([^\\s]+)`));

    return {
      path,
      packageName,
      minVersion,
      actualVersions: moduleMatch?.[1] ? [moduleMatch[1]] : [],
    };
  });
};

const uvLockMinimums: Record<string, string> = {
  aiohttp: '3.13.4',
  black: '26.3.1',
  gunicorn: '22.0.0',
  lxml: '6.1.0',
  nltk: '3.9.4',
  pillow: '12.2.0',
  pypdf: '6.10.1',
  pytest: '9.0.3',
  'python-dotenv': '1.0.0',
  'python-multipart': '0.0.26',
  requests: '2.33.0',
  tinytag: '2.2.1',
  transformers: '5.0.0rc3',
};

const packageLockMinimums: Record<string, string> = {
  'brace-expansion': '5.0.5',
  esbuild: '0.25.0',
  'lodash-es': '4.18.0',
  postcss: '8.5.10',
  rollup: '4.59.0',
  vite: '6.4.2',
};

describe('ABLP-676 SCA dependency upgrades', () => {
  test('regenerates scoped manifests and lockfiles with non-vulnerable dependency versions', () => {
    const expectations: VersionExpectation[] = [
      ...extractUvLockPackageVersions(
        'services/docling-service/uv.lock',
        Object.keys(uvLockMinimums),
      ),
      ...extractUvLockPackageVersions(
        'services/preprocessing-service/uv.lock',
        Object.keys(uvLockMinimums),
      ),
      ...extractPyprojectDependencyVersions('services/docling-service/pyproject.toml', {
        pillow: '12.2.0',
        pytest: '9.0.3',
        'python-multipart': '0.0.26',
      }),
      ...extractPyprojectDependencyVersions('services/preprocessing-service/pyproject.toml', {
        black: '26.3.1',
        flask: '3.1.3',
        gunicorn: '22.0.0',
        nltk: '3.9.4',
        pytest: '9.0.3',
        'python-dotenv': '1.0.0',
      }),
      ...extractRequirementVersions('apps/nlu-sidecar/requirements.txt', {
        flask: '3.1.3',
      }),
      ...extractPnpmLockVersions('pnpm-lock.yaml', {
        '@xmldom/xmldom': '0.8.13',
        ajv: '8.18.0',
        'basic-ftp': '5.3.1',
        'fast-xml-parser': '5.7.0',
        'markdown-it': '14.1.1',
        postcss: '8.5.10',
        uuid: '14.0.0',
      }),
      ...extractPackageLockVersions('packages/analyzer/package-lock.json', packageLockMinimums),
      ...extractPackageLockVersions('packages/compiler/package-lock.json', packageLockMinimums),
      ...extractPackageLockVersions('packages/core/package-lock.json', packageLockMinimums),
      ...extractPackageLockVersions('packages/nl-parser/package-lock.json', packageLockMinimums),
      ...extractPackageLockVersions('apps/crawler-go-worker/package-lock.json', {
        uuid: '14.0.0',
      }),
      ...extractGoModVersions('apps/crawler-go-worker/go.mod', {
        'github.com/redis/go-redis/v9': '9.7.3',
        'golang.org/x/net': '0.38.0',
        'google.golang.org/protobuf': '1.33.0',
      }),
    ];
    const forbiddenPackageExpectations = [
      ...extractForbiddenPackageLockVersions('packages/analyzer/package-lock.json', ['minimatch']),
      ...extractForbiddenPackageLockVersions('packages/compiler/package-lock.json', ['minimatch']),
      ...extractForbiddenPackageLockVersions('packages/core/package-lock.json', ['minimatch']),
      ...extractForbiddenPackageLockVersions('packages/nl-parser/package-lock.json', ['minimatch']),
    ];

    const missing = expectations
      .filter(({ actualVersions, required }) => required === true && actualVersions.length === 0)
      .map(({ path, packageName }) => `${path}: missing ${packageName}`);
    const outdated = formatOutdatedVersions(expectations);
    const forbidden = forbiddenPackageExpectations.flatMap(
      ({ path, packageName, actualVersions }) =>
        actualVersions.map(
          (actualVersion) => `${path}: ${packageName}@${actualVersion} is forbidden`,
        ),
    );

    expect([...missing, ...outdated, ...forbidden]).toEqual([]);
  });
});
