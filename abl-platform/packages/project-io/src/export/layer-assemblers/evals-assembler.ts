import type { LayerAssembler, LayerQueryContext } from './types.js';
import type { LayerAssemblyResult } from '../../types.js';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { EvalSet, EvalScenario, EvalPersona, EvalEvaluator } from '@agent-platform/database/models';
import { sanitizeName, stripInternalFields } from './assembler-utils.js';
import { assignCollisionSafePath } from '../folder-builder.js';

const log = createLogger('evals-assembler');

function directoryHasFiles(files: Map<string, string>, directoryPath: string): boolean {
  const prefix = `${directoryPath}/`;
  return [...files.keys()].some((path) => path.startsWith(prefix));
}

function assignCollisionSafeDirectoryPath(
  directoryPath: string,
  files: Map<string, string>,
): string {
  if (!directoryHasFiles(files, directoryPath)) {
    return directoryPath;
  }

  for (let suffix = 2; suffix <= 100; suffix++) {
    const candidate = `${directoryPath}_${suffix}`;
    if (!directoryHasFiles(files, candidate)) {
      return candidate;
    }
  }

  throw new Error(`Too many directory collisions for path "${directoryPath}"`);
}

export class EvalsAssembler implements LayerAssembler {
  readonly layer = 'evals' as const;

  async assemble(ctx: LayerQueryContext): Promise<LayerAssemblyResult> {
    const { projectId, tenantId } = ctx;
    const files = new Map<string, string>();
    const warnings: string[] = [];
    let entityCount = 0;

    const [evalSets, scenarios, personas, evaluators] = await Promise.all([
      EvalSet.find({ projectId, tenantId })
        .lean()
        .select(
          'name description personaIds scenarioIds evaluatorIds variants maxConcurrency regressionThreshold ciEnabled personaModel personaModelConfig createdBy',
        ),
      EvalScenario.find({ projectId, tenantId })
        .lean()
        .select(
          'name description category difficulty entryAgent initialMessage expectedOutcome maxTurns tags agentPath expectedMilestones maxToolCalls version createdBy',
        ),
      EvalPersona.find({ projectId, tenantId })
        .lean()
        .select(
          'name description communicationStyle domainKnowledge behaviorTraits goals constraints sessionVariables systemPrompt source isAdversarial adversarialType isBuiltIn createdBy',
        ),
      EvalEvaluator.find({ projectId, tenantId })
        .lean()
        .select(
          'name description type category judgeModel judgePrompt chainOfThought temperature scoringRubric biasSettings scorerName scorerConfig trajectoryMetrics isBuiltIn createdBy',
        ),
    ]);

    // Build ID→name maps for resolving set references
    const scenarioMap = new Map(scenarios.map((s) => [String(s._id), s]));
    const personaMap = new Map(personas.map((p) => [String(p._id), p]));

    // Eval sets with nested scenarios and personas
    for (const evalSet of evalSets) {
      const setName = sanitizeName(evalSet.name);
      const setDir = assignCollisionSafeDirectoryPath(`evals/${setName}`, files);

      const cleanSet = stripInternalFields(evalSet as unknown as Record<string, unknown>);
      files.set(`${setDir}/eval-set.json`, JSON.stringify(cleanSet, null, 2));
      entityCount++;

      // Nested scenarios for this set
      for (const scenarioId of evalSet.scenarioIds ?? []) {
        const scenario = scenarioMap.get(String(scenarioId));
        if (scenario) {
          const scenarioName = sanitizeName(scenario.name);
          const cleanScenario = stripInternalFields(scenario as unknown as Record<string, unknown>);
          const path = assignCollisionSafePath(
            `${setDir}/scenarios/${scenarioName}.scenario.json`,
            files,
          );
          files.set(path, JSON.stringify(cleanScenario, null, 2));
        } else {
          warnings.push(`Eval set "${evalSet.name}" references missing scenario ID: ${scenarioId}`);
        }
      }

      // Nested personas for this set
      for (const personaId of evalSet.personaIds ?? []) {
        const persona = personaMap.get(String(personaId));
        if (persona) {
          const personaName = sanitizeName(persona.name);
          const cleanPersona = stripInternalFields(persona as unknown as Record<string, unknown>);
          const path = assignCollisionSafePath(
            `${setDir}/personas/${personaName}.persona.json`,
            files,
          );
          files.set(path, JSON.stringify(cleanPersona, null, 2));
        } else {
          warnings.push(`Eval set "${evalSet.name}" references missing persona ID: ${personaId}`);
        }
      }
    }

    // Standalone scenarios not nested in a set
    const nestedScenarioIds = new Set(evalSets.flatMap((s) => (s.scenarioIds ?? []).map(String)));
    for (const scenario of scenarios) {
      if (!nestedScenarioIds.has(String(scenario._id))) {
        const scenarioName = sanitizeName(scenario.name);
        const cleanScenario = stripInternalFields(scenario as unknown as Record<string, unknown>);
        const path = assignCollisionSafePath(
          `evals/scenarios/${scenarioName}.scenario.json`,
          files,
        );
        files.set(path, JSON.stringify(cleanScenario, null, 2));
        entityCount++;
      }
    }

    // Standalone personas not nested in a set
    const nestedPersonaIds = new Set(evalSets.flatMap((s) => (s.personaIds ?? []).map(String)));
    for (const persona of personas) {
      if (!nestedPersonaIds.has(String(persona._id))) {
        const personaName = sanitizeName(persona.name);
        const cleanPersona = stripInternalFields(persona as unknown as Record<string, unknown>);
        const path = assignCollisionSafePath(`evals/personas/${personaName}.persona.json`, files);
        files.set(path, JSON.stringify(cleanPersona, null, 2));
        entityCount++;
      }
    }

    // Evaluators (shared across sets) — emit _exportedId for cross-ref resolution
    for (const evaluator of evaluators) {
      const evalName = sanitizeName(evaluator.name);
      const originalId = String((evaluator as Record<string, unknown>)._id);
      const cleanEvaluator = stripInternalFields(evaluator as unknown as Record<string, unknown>);
      cleanEvaluator._exportedId = originalId;
      const path = assignCollisionSafePath(`evals/evaluators/${evalName}.evaluator.json`, files);
      files.set(path, JSON.stringify(cleanEvaluator, null, 2));
      entityCount++;
    }

    log.info('Evals layer assembled', {
      projectId,
      sets: evalSets.length,
      scenarios: scenarios.length,
      personas: personas.length,
      evaluators: evaluators.length,
    });

    return { layer: 'evals', files, entityCount, warnings };
  }

  async countEntities(ctx: LayerQueryContext): Promise<number> {
    const { projectId, tenantId } = ctx;
    const [sets, scenarios, personas, evaluators] = await Promise.all([
      EvalSet.countDocuments({ projectId, tenantId }),
      EvalScenario.countDocuments({ projectId, tenantId }),
      EvalPersona.countDocuments({ projectId, tenantId }),
      EvalEvaluator.countDocuments({ projectId, tenantId }),
    ]);
    return sets + scenarios + personas + evaluators;
  }
}
