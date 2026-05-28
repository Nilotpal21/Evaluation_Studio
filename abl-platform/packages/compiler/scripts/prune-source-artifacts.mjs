import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: packageRoot,
  encoding: 'utf8',
}).trim();
const srcRoot = path.relative(repoRoot, path.join(packageRoot, 'src'));
const generatedSourceSuffixes = ['.js', '.js.map', '.d.ts', '.d.ts.map'];

function isGeneratedSourceArtifact(filePath) {
  return generatedSourceSuffixes.some((suffix) => filePath.endsWith(suffix));
}

function getIgnoredSourceArtifacts() {
  const output = execFileSync('git', ['status', '--ignored', '--porcelain', srcRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('!! '))
    .map((line) => line.slice(3))
    .filter(isGeneratedSourceArtifact);
}

const ignoredSourceArtifacts = getIgnoredSourceArtifacts();

for (const relativePath of ignoredSourceArtifacts) {
  rmSync(path.join(repoRoot, relativePath), { force: true });
}

if (ignoredSourceArtifacts.length > 0) {
  console.log(
    `Pruned ${ignoredSourceArtifacts.length} ignored source artifacts before compiler tests.`,
  );
}
