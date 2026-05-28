/**
 * Offline Blueprint v2 battle test.
 *
 * Creates 10 rendered project artifacts from structured blueprints. When the
 * parser/compiler can be loaded in the active Node environment, it also parses
 * each generated agent DSL and compiles each project to IR.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  BLUEPRINT_BATTLE_TEST_FIXTURES,
  renderProjectFromBlueprint,
  validateBlueprintV2Output,
} from '../../packages/arch-ai/src/blueprint/index.js';
import {
  deriveProjectIntelligencePlanFromBlueprint,
  deriveProjectConstructPlanFromBlueprint,
  validateProjectIntelligenceFit,
  validateProjectConstructPlan,
} from '../../packages/arch-ai/src/planning/index.js';

interface ProjectResult {
  projectName: string;
  status: 'success' | 'failed';
  agentCount: number;
  errors: string[];
  constructIssueCount: number;
  intelligenceIssueCount: number;
  parserCompilerAvailable: boolean;
}

function parseArgs(argv: string[]): { outputRoot: string; runId: string } {
  let runId = `blueprint-battle-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19)}`;
  let outputRoot = '';
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--run-id') {
      runId = argv[++index] ?? runId;
    } else if (arg === '--output-root') {
      outputRoot = argv[++index] ?? outputRoot;
    }
  }
  return {
    runId,
    outputRoot: outputRoot || path.join(process.cwd(), 'docs/testing/arch-eval', runId),
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  await fs.mkdir(args.outputRoot, { recursive: true });

  const results: ProjectResult[] = [];
  let parserCompiler: {
    parseAgentBasedABL: typeof import('@abl/core').parseAgentBasedABL;
    compileABLtoIR: typeof import('@abl/compiler').compileABLtoIR;
  } | null = null;
  let parserCompilerLoadError: string | null = null;
  try {
    const core = await import('@abl/core');
    const compiler = await import('@abl/compiler');
    parserCompiler = {
      parseAgentBasedABL: core.parseAgentBasedABL,
      compileABLtoIR: compiler.compileABLtoIR,
    };
  } catch (err: unknown) {
    parserCompilerLoadError = err instanceof Error ? err.message : String(err);
  }

  for (const blueprint of BLUEPRINT_BATTLE_TEST_FIXTURES) {
    const projectDir = path.join(
      args.outputRoot,
      blueprint.metadata.projectName.replace(/\s+/g, '-'),
    );
    const agentDir = path.join(projectDir, 'agents');
    await fs.mkdir(agentDir, { recursive: true });

    const errors: string[] = [];
    const validationIssues = validateBlueprintV2Output(blueprint);
    if (validationIssues.length > 0) {
      errors.push(...validationIssues.map((issue) => `${issue.code}: ${issue.message}`));
    }

    const constructPlan = deriveProjectConstructPlanFromBlueprint(blueprint);
    const constructValidation = validateProjectConstructPlan(constructPlan);
    const intelligencePlan = deriveProjectIntelligencePlanFromBlueprint(blueprint);
    const intelligenceValidation = validateProjectIntelligenceFit(intelligencePlan, constructPlan);
    errors.push(
      ...constructValidation.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => `construct ${issue.code} at ${issue.path}: ${issue.message}`),
      ...intelligenceValidation.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => `intelligence ${issue.code} at ${issue.path}: ${issue.message}`),
    );

    const rendered = renderProjectFromBlueprint(blueprint);
    const documents = [];
    for (const agent of rendered.agents) {
      await fs.writeFile(path.join(agentDir, `${agent.name}.agent.abl`), agent.dslContent, 'utf8');
      if (parserCompiler) {
        const parsed = parserCompiler.parseAgentBasedABL(agent.dslContent);
        if (parsed.errors.length > 0) {
          errors.push(
            ...parsed.errors.map(
              (error) => `${agent.name}: parse line ${error.line}: ${error.message}`,
            ),
          );
        }
        if (parsed.document) {
          documents.push(parsed.document);
        }
      }
    }

    let compiled: unknown;
    if (parserCompiler) {
      const compiledOutput = parserCompiler.compileABLtoIR(documents, { mode: 'preview' });
      compiled = compiledOutput;
      if ((compiledOutput.errors ?? []).length > 0) {
        errors.push(
          ...(compiledOutput.errors ?? []).map(
            (error) => `${error.agent ?? 'project'}: ${error.message}`,
          ),
        );
      }
    } else {
      compiled = { skipped: true, reason: parserCompilerLoadError };
    }

    await writeJson(path.join(projectDir, 'blueprint.json'), blueprint);
    await writeJson(path.join(projectDir, 'construct-plan.json'), constructPlan);
    await writeJson(path.join(projectDir, 'construct-validation.json'), constructValidation);
    await writeJson(path.join(projectDir, 'intelligence-plan.json'), intelligencePlan);
    await writeJson(path.join(projectDir, 'intelligence-validation.json'), intelligenceValidation);
    await fs.writeFile(path.join(projectDir, 'blueprint.md'), rendered.markdown, 'utf8');
    await writeJson(path.join(projectDir, 'compile.json'), compiled);
    await writeJson(path.join(projectDir, 'final.json'), {
      projectName: rendered.projectName,
      entryAgentName: rendered.entryAgentName,
      agentCount: rendered.agents.length,
      errors,
      constructIssueCount: constructValidation.issues.length,
      intelligenceIssueCount: intelligenceValidation.issues.length,
      status: errors.length === 0 ? 'success' : 'failed',
      parserCompilerAvailable: parserCompiler !== null,
    });

    results.push({
      projectName: rendered.projectName,
      status: errors.length === 0 ? 'success' : 'failed',
      agentCount: rendered.agents.length,
      errors,
      constructIssueCount: constructValidation.issues.length,
      intelligenceIssueCount: intelligenceValidation.issues.length,
      parserCompilerAvailable: parserCompiler !== null,
    });
  }

  const successCount = results.filter((result) => result.status === 'success').length;
  await writeJson(path.join(args.outputRoot, 'summary.json'), {
    runId: args.runId,
    createdAt: new Date().toISOString(),
    successCount,
    total: results.length,
    results,
    parserCompilerLoadError,
  });

  const summaryMd = [
    '# Blueprint Battle Test',
    '',
    `Run: ${args.runId}`,
    `Success: ${successCount} / ${results.length}`,
    '',
    '| Project | Status | Agents | Construct Issues | Intelligence Issues | Errors |',
    '|---|---|---:|---:|---:|---:|',
    ...results.map(
      (result) =>
        `| ${result.projectName} | ${result.status} | ${result.agentCount} | ${result.constructIssueCount} | ${result.intelligenceIssueCount} | ${result.errors.length} |`,
    ),
    '',
  ].join('\n');
  await fs.writeFile(path.join(args.outputRoot, 'summary.md'), summaryMd, 'utf8');

  if (successCount !== results.length) {
    throw new Error(`Blueprint battle test failed: ${successCount}/${results.length} successful`);
  }

  process.stdout.write(
    `[blueprint-battle] ${successCount}/${results.length} projects successful\n`,
  );
  process.stdout.write(`[blueprint-battle] output: ${args.outputRoot}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
