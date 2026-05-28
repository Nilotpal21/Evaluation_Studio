import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

interface TsConfig {
  compilerOptions?: {
    paths?: Record<string, string[]>;
  };
}

interface PackageJson {
  name?: string;
  exports?: Record<string, ExportTarget>;
}

type ExportTarget =
  | string
  | {
      types?: string;
      import?: string;
      default?: string;
    }
  | null;

interface WorkspacePackageCheck {
  packageJsonPath: string;
  sourceRoot: string;
}

interface Failure {
  alias: string;
  message: string;
}

interface PublicAliasExpectation {
  alias: string;
  declarationPath: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const workspacePackages: WorkspacePackageCheck[] = [
  {
    packageJsonPath: 'packages/compiler/package.json',
    sourceRoot: 'packages/compiler/src',
  },
];

function selectExportTarget(target: ExportTarget): string | null {
  if (typeof target === 'string') {
    return target;
  }

  if (!target || typeof target !== 'object') {
    return null;
  }

  if (typeof target.types === 'string') {
    return target.types;
  }

  if (typeof target.import === 'string') {
    return target.import;
  }

  if (typeof target.default === 'string') {
    return target.default;
  }

  return null;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function toWorkspaceRelativePath(packageJsonPath: string, targetPath: string): string | null {
  const normalizedTarget = toPosixPath(targetPath);
  if (!normalizedTarget.startsWith('./dist/') || !normalizedTarget.endsWith('/index.d.ts')) {
    return null;
  }

  const packageDirectory = path.posix.dirname(toPosixPath(packageJsonPath));
  return `${packageDirectory}/${normalizedTarget.replace(/^\.\//, '')}`;
}

function getPublicAliasExpectations(
  packageJsonPath: string,
  packageJson: PackageJson,
): PublicAliasExpectation[] {
  const packageName = packageJson.name;
  const exportsField = packageJson.exports ?? {};
  const expectations: PublicAliasExpectation[] = [];

  if (!packageName) {
    return expectations;
  }

  expectations.push({
    alias: packageName,
    declarationPath: `${path.posix.dirname(toPosixPath(packageJsonPath))}/dist/index.d.ts`,
  });

  for (const [subpath, target] of Object.entries(exportsField)) {
    if (subpath === '.' || subpath.includes('*') || subpath.endsWith('.js')) {
      continue;
    }

    const exportTarget = selectExportTarget(target);
    if (!exportTarget) {
      continue;
    }

    const declarationPath = toWorkspaceRelativePath(packageJsonPath, exportTarget);
    if (!declarationPath) {
      continue;
    }

    expectations.push({
      alias: `${packageName}/${subpath.slice(2)}`,
      declarationPath,
    });
  }

  return expectations;
}

async function main(): Promise<void> {
  const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
  const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8')) as TsConfig;
  const paths = tsconfig.compilerOptions?.paths ?? {};
  const parsedTsconfig = ts.parseJsonConfigFileContent(
    ts.readConfigFile(tsconfigPath, ts.sys.readFile).config,
    ts.sys,
    repoRoot,
  );
  const resolutionHostPath = path.join(repoRoot, 'tools', '__workspace-path-check__.ts');
  const failures: Failure[] = [];

  for (const config of workspacePackages) {
    const packageJsonPath = path.join(repoRoot, config.packageJsonPath);
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as PackageJson;
    const packageName = packageJson.name;

    if (!packageName) {
      failures.push({
        alias: config.packageJsonPath,
        message: 'Package is missing a name field.',
      });
      continue;
    }

    const wildcardAlias = `${packageName}/*`;
    const wildcardSourceRoot = `${config.sourceRoot}/*`;
    const wildcardTargets = paths[wildcardAlias] ?? [];
    if (!wildcardTargets.includes(wildcardSourceRoot)) {
      failures.push({
        alias: wildcardAlias,
        message: `Expected wildcard path alias to include "${wildcardSourceRoot}".`,
      });
    }

    for (const { alias, declarationPath } of getPublicAliasExpectations(
      config.packageJsonPath,
      packageJson,
    )) {
      if (!existsSync(path.join(repoRoot, declarationPath))) {
        failures.push({
          alias,
          message: `Declaration entrypoint "${declarationPath}" does not exist. Build the dependency first.`,
        });
        continue;
      }

      const aliasTargets = paths[alias] ?? [];
      if (!aliasTargets.includes(declarationPath)) {
        failures.push({
          alias,
          message: `Expected tsconfig path alias to include "${declarationPath}".`,
        });
        continue;
      }

      const resolution = ts.resolveModuleName(
        alias,
        resolutionHostPath,
        parsedTsconfig.options,
        ts.sys,
      );
      const resolvedPath = resolution.resolvedModule?.resolvedFileName;
      const expectedPath = path.join(repoRoot, declarationPath);
      if (!resolvedPath) {
        failures.push({
          alias,
          message: 'TypeScript could not resolve the alias under the root workspace config.',
        });
        continue;
      }

      if (toPosixPath(path.resolve(resolvedPath)) !== toPosixPath(expectedPath)) {
        failures.push({
          alias,
          message: `TypeScript resolved to "${path.relative(repoRoot, resolvedPath)}" instead of "${declarationPath}".`,
        });
      }
    }
  }

  if (failures.length > 0) {
    console.error('Workspace export path check failed:\n');
    for (const failure of failures) {
      console.error(`- ${failure.alias}: ${failure.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Workspace export path check passed for ${workspacePackages.length} workspace package${workspacePackages.length === 1 ? '' : 's'}.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
