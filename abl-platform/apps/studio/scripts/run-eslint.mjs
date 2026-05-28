import { ESLint } from 'eslint';

const targets = process.argv.slice(2);
const lintTargets = targets.length > 0 ? targets : ['src/**/*.{ts,tsx}'];

const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfigFile: 'eslint.config.mjs',
});

const results = await eslint.lintFiles(lintTargets);
const formatter = await eslint.loadFormatter('stylish');
const output = formatter.format(results);

if (output) {
  process.stdout.write(output);
}

const hasErrors = results.some((result) => result.errorCount > 0 || result.fatalErrorCount > 0);
process.exitCode = hasErrors ? 1 : 0;
