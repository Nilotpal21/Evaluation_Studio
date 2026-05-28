import fs from 'node:fs';
import path from 'node:path';
import { TOOL_ROOT } from './constants.mjs';
import { getStudioSurface } from './studio-harness.mjs';
import { ensureDir, sanitizeFileName } from './utils.mjs';

const DEFAULT_SCENARIO_DESCRIPTION_PREFIX = 'Scaffolded Studio evidence scenario';

function toTitleCase(value) {
  return String(value)
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeImportPath(fromDir, targetFile) {
  const relativePath = path.relative(fromDir, targetFile).split(path.sep).join('/');
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

function renderScenarioTemplate({ description, outputPath, scenarioId, surface, title }) {
  const outputDir = path.dirname(outputPath);
  const utilsImportPath = normalizeImportPath(outputDir, path.join(TOOL_ROOT, 'lib', 'utils.mjs'));
  const harnessImportPath = normalizeImportPath(
    outputDir,
    path.join(TOOL_ROOT, 'lib', 'studio-harness.mjs'),
  );
  const assistantReplyBlock = surface.requiresAgent
    ? `      assistantReply: String(
        options.assistantReply ??
          'Acknowledged. Scaffolded Studio evidence scenario reply completed successfully.',
      ).trim(),\n`
    : '';

  return `import { numberFromInput } from ${JSON.stringify(utilsImportPath)};
import { createStudioFixture, openStudioSurface } from ${JSON.stringify(harnessImportPath)};

export const scenario = {
  id: ${JSON.stringify(scenarioId)},
  title: ${JSON.stringify(title)},
  description: ${JSON.stringify(description)},
  example: ${JSON.stringify(`pnpm studio:video:evidence -- --scenario ${scenarioId}`)},
  async run(context) {
    const { options, artifacts, page } = context;
    const fixture = await createStudioFixture(context, {
      requireProject: ${surface.requiresProject},
      requireAgent: ${surface.requiresAgent},
${assistantReplyBlock}    });

    const navigation = await openStudioSurface(context, ${JSON.stringify(surface.id)}, fixture);
    await artifacts.captureScreenshot(${JSON.stringify(`${surface.id}-ready.png`)});

    // Add scenario-specific interactions and assertions here.

    const finalPauseMs = numberFromInput(options.finalPauseMs, 2_000);
    await page.waitForTimeout(finalPauseMs);

    return {
      summary: ${JSON.stringify(`Scaffolded Studio evidence scenario loaded the ${surface.title} surface.`)},
      metadata: {
        surfaceId: navigation.surface.id,
        route: navigation.route,
        projectId: fixture.projectId ?? null,
        projectName: fixture.projectName ?? null,
        agentName: fixture.agentName ?? null,
        email: fixture.email,
      },
      assertions: [
        {
          name: 'surface-ready',
          passed: true,
          details: \`Loaded \${navigation.surface.title} at \${navigation.route}\`,
        },
      ],
    };
  },
};
`;
}

export function scaffoldScenario({
  scenarioId,
  surfaceId = 'agent-chat',
  title,
  description,
  outputPath,
  force = false,
}) {
  const normalizedScenarioId = sanitizeFileName(scenarioId);
  if (!normalizedScenarioId) {
    throw new Error('Scenario id must contain at least one alphanumeric character.');
  }

  const surface = getStudioSurface(surfaceId);
  if (!surface) {
    throw new Error(`Unknown Studio surface "${String(surfaceId)}".`);
  }

  const resolvedTitle = title?.trim() || toTitleCase(normalizedScenarioId);
  const resolvedDescription =
    description?.trim() || `${DEFAULT_SCENARIO_DESCRIPTION_PREFIX} for ${surface.title}.`;
  const resolvedOutputPath = path.resolve(
    outputPath?.trim() ||
      path.join(TOOL_ROOT, 'scenarios', `${sanitizeFileName(normalizedScenarioId)}.mjs`),
  );

  ensureDir(path.dirname(resolvedOutputPath));

  if (!force && fs.existsSync(resolvedOutputPath)) {
    throw new Error(`Refusing to overwrite existing scenario scaffold at ${resolvedOutputPath}.`);
  }

  fs.writeFileSync(
    resolvedOutputPath,
    renderScenarioTemplate({
      description: resolvedDescription,
      outputPath: resolvedOutputPath,
      scenarioId: normalizedScenarioId,
      surface,
      title: resolvedTitle,
    }),
    'utf8',
  );

  return {
    scenarioId: normalizedScenarioId,
    surfaceId: surface.id,
    title: resolvedTitle,
    description: resolvedDescription,
    outputPath: resolvedOutputPath,
    autoDiscovered:
      resolvedOutputPath.startsWith(path.join(TOOL_ROOT, 'scenarios') + path.sep) ||
      resolvedOutputPath ===
        path.join(TOOL_ROOT, 'scenarios', `${sanitizeFileName(normalizedScenarioId)}.mjs`),
  };
}
