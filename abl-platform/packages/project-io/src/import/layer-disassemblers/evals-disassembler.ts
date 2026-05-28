/**
 * Evals Layer Disassembler — converts exported eval files back into StagedRecord[].
 *
 * Handles nested eval sets (with scenarios/personas under set dirs) and
 * standalone scenarios/personas/evaluators at the top level.
 *
 * Cross-reference note: nested scenarios/personas set `_parentSetName` temp field
 * for resolution in the cross-ref pass. Eval sets have their stale scenarioIds
 * and personaIds cleared; they will be rebuilt from _nestedScenarioNames and
 * _nestedPersonaNames during cross-ref resolution.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import type { LayerDisassembler, DisassembleContext, DisassembleResult } from './types.js';
import {
  safeParseJSON,
  injectOwnership,
  buildRecord,
  buildSuperseded,
  buildMatchingSuperseded,
} from './disassembler-utils.js';

const log = createLogger('evals-disassembler');

// ─── Collections ──────────────────────────────────────────────────────────

const EVAL_SETS = 'eval_sets';
const EVAL_SCENARIOS = 'eval_scenarios';
const EVAL_PERSONAS = 'eval_personas';
const EVAL_EVALUATORS = 'eval_evaluators';

// ─── File Path Classification ─────────────────────────────────────────────

export interface ClassifiedEvalFile {
  type:
    | 'eval-set'
    | 'nested-scenario'
    | 'nested-persona'
    | 'standalone-scenario'
    | 'standalone-persona'
    | 'evaluator'
    | 'unknown';
  setName?: string;
  entityName?: string;
}

export function classifyEvalFile(path: string): ClassifiedEvalFile {
  // evals/{setName}/eval-set.json
  const setMatch = path.match(/^evals\/([^/]+)\/eval-set\.json$/);
  if (setMatch) return { type: 'eval-set', setName: setMatch[1] };

  // evals/{setName}/scenarios/{name}.scenario.json
  const nestedScenario = path.match(/^evals\/([^/]+)\/scenarios\/([^/]+)\.scenario\.json$/);
  if (nestedScenario)
    return {
      type: 'nested-scenario',
      setName: nestedScenario[1],
      entityName: nestedScenario[2],
    };

  // evals/{setName}/personas/{name}.persona.json
  const nestedPersona = path.match(/^evals\/([^/]+)\/personas\/([^/]+)\.persona\.json$/);
  if (nestedPersona)
    return {
      type: 'nested-persona',
      setName: nestedPersona[1],
      entityName: nestedPersona[2],
    };

  // evals/scenarios/{name}.scenario.json
  const standaloneScenario = path.match(/^evals\/scenarios\/([^/]+)\.scenario\.json$/);
  if (standaloneScenario) return { type: 'standalone-scenario', entityName: standaloneScenario[1] };

  // evals/personas/{name}.persona.json
  const standalonePersona = path.match(/^evals\/personas\/([^/]+)\.persona\.json$/);
  if (standalonePersona) return { type: 'standalone-persona', entityName: standalonePersona[1] };

  // evals/evaluators/{name}.evaluator.json
  const evaluator = path.match(/^evals\/evaluators\/([^/]+)\.evaluator\.json$/);
  if (evaluator) return { type: 'evaluator', entityName: evaluator[1] };

  return { type: 'unknown' };
}

// ─── Disassembler ─────────────────────────────────────────────────────────

export class EvalsDisassembler implements LayerDisassembler {
  readonly layer = 'evals' as const;

  async disassemble(ctx: DisassembleContext): Promise<DisassembleResult> {
    const records: DisassembleResult['records'] = [];
    const superseded: DisassembleResult['superseded'] = [];
    const warnings: string[] = [];
    const ownership = {
      projectId: ctx.projectId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    };

    // Track eval set data for nested entity bookkeeping
    const evalSetDataMap = new Map<
      string,
      {
        data: Record<string, unknown>;
        nestedScenarioNames: string[];
        nestedPersonaNames: string[];
        nestedEvaluatorNames: string[];
      }
    >();

    // ── PHASE 0: Pre-scan evaluators to build oldId → name map ──────────
    // Evaluators are shared (not nested), so we use _exportedId to resolve
    // stale evaluatorIds on eval sets into evaluator names.

    const evaluatorOldIdToName = new Map<string, string>();
    for (const [filePath, content] of ctx.files) {
      const classified = classifyEvalFile(filePath);
      if (classified.type === 'evaluator') {
        const parsed = safeParseJSON(filePath, content, warnings);
        if (!parsed) continue;
        const exportedEvaluatorId = parsed.id ?? parsed._exportedId;
        if (
          typeof exportedEvaluatorId === 'string' &&
          exportedEvaluatorId.length > 0 &&
          typeof parsed.name === 'string'
        ) {
          evaluatorOldIdToName.set(exportedEvaluatorId, parsed.name);
        }
      }
    }

    // ── PHASE 1: Discover eval sets and collect nested entities ──────────

    for (const [filePath, content] of ctx.files) {
      const classified = classifyEvalFile(filePath);

      if (classified.type === 'eval-set' && classified.setName) {
        const parsed = safeParseJSON(filePath, content, warnings);
        if (!parsed) continue;

        // Resolve stale evaluatorIds → evaluator names via _exportedId map
        const resolvedEvaluatorNames: string[] = [];
        if (Array.isArray(parsed.evaluatorIds)) {
          for (const oldId of parsed.evaluatorIds) {
            const name = evaluatorOldIdToName.get(String(oldId));
            if (name) {
              resolvedEvaluatorNames.push(name);
            } else {
              warnings.push(
                `Eval set "${parsed.name ?? classified.setName}": evaluatorId "${oldId}" could not be resolved to an evaluator name`,
              );
            }
          }
        }

        // Clear stale ObjectId arrays — will be rebuilt in cross-ref pass
        parsed.scenarioIds = [];
        parsed.personaIds = [];
        parsed.evaluatorIds = [];
        // Add temp fields for cross-ref resolution
        parsed._nestedScenarioNames = [];
        parsed._nestedPersonaNames = [];
        parsed._nestedEvaluatorNames = resolvedEvaluatorNames;

        const data = injectOwnership(parsed, ownership);
        records.push(buildRecord('evals', EVAL_SETS, data));

        evalSetDataMap.set(classified.setName, {
          data,
          nestedScenarioNames: data._nestedScenarioNames as string[],
          nestedPersonaNames: data._nestedPersonaNames as string[],
          nestedEvaluatorNames: data._nestedEvaluatorNames as string[],
        });
      }
    }

    // ── PHASE 1b: Parse nested scenarios and personas ───────────────────

    for (const [filePath, content] of ctx.files) {
      const classified = classifyEvalFile(filePath);

      if (classified.type === 'nested-scenario' && classified.setName) {
        const parsed = safeParseJSON(filePath, content, warnings);
        if (!parsed) continue;

        // Set temp join field for cross-ref resolution
        // Use the eval set's actual JSON name (not the sanitized directory name)
        // so the composite key matches in the cross-ref resolver's STEP 3 lookup.
        const parentEntry = evalSetDataMap.get(classified.setName);
        parsed._parentSetName = (parentEntry?.data.name as string) ?? classified.setName;
        const data = injectOwnership(parsed, ownership);
        records.push(buildRecord('evals', EVAL_SCENARIOS, data));

        // Track the name for the parent set's _nestedScenarioNames
        const setEntry = evalSetDataMap.get(classified.setName);
        if (setEntry && typeof data.name === 'string') {
          setEntry.nestedScenarioNames.push(data.name);
        }
      }

      if (classified.type === 'nested-persona' && classified.setName) {
        const parsed = safeParseJSON(filePath, content, warnings);
        if (!parsed) continue;

        // Set temp join field for cross-ref resolution (actual name, not directory name)
        const parentEntryP = evalSetDataMap.get(classified.setName);
        parsed._parentSetName = (parentEntryP?.data.name as string) ?? classified.setName;
        const data = injectOwnership(parsed, ownership);
        records.push(buildRecord('evals', EVAL_PERSONAS, data));

        // Track the name for the parent set's _nestedPersonaNames
        const setEntry = evalSetDataMap.get(classified.setName);
        if (setEntry && typeof data.name === 'string') {
          setEntry.nestedPersonaNames.push(data.name);
        }
      }
    }

    // ── PHASE 2: Standalone scenarios ───────────────────────────────────

    for (const [filePath, content] of ctx.files) {
      const classified = classifyEvalFile(filePath);

      if (classified.type === 'standalone-scenario') {
        const parsed = safeParseJSON(filePath, content, warnings);
        if (!parsed) continue;

        const data = injectOwnership(parsed, ownership);
        records.push(buildRecord('evals', EVAL_SCENARIOS, data));
      }
    }

    // ── PHASE 3: Standalone personas ────────────────────────────────────

    for (const [filePath, content] of ctx.files) {
      const classified = classifyEvalFile(filePath);

      if (classified.type === 'standalone-persona') {
        const parsed = safeParseJSON(filePath, content, warnings);
        if (!parsed) continue;

        const data = injectOwnership(parsed, ownership);
        records.push(buildRecord('evals', EVAL_PERSONAS, data));
      }
    }

    // ── PHASE 4: Evaluators ─────────────────────────────────────────────

    for (const [filePath, content] of ctx.files) {
      const classified = classifyEvalFile(filePath);

      if (classified.type === 'evaluator') {
        const parsed = safeParseJSON(filePath, content, warnings);
        if (!parsed) continue;
        const exportedEvaluatorId = parsed.id ?? parsed._exportedId;
        if (typeof exportedEvaluatorId === 'string' && exportedEvaluatorId.length > 0) {
          parsed._exportedId = exportedEvaluatorId;
        }

        const data = injectOwnership(parsed, ownership);
        records.push(buildRecord('evals', EVAL_EVALUATORS, data));
      }
    }

    // ── Superseded records ──────────────────────────────────────────────

    if (ctx.conflictStrategy === 'replace' && ctx.existingRecordIds) {
      superseded.push(...buildSuperseded('evals', EVAL_SETS, ctx.existingRecordIds.get(EVAL_SETS)));
      superseded.push(
        ...buildSuperseded('evals', EVAL_SCENARIOS, ctx.existingRecordIds.get(EVAL_SCENARIOS)),
      );
      superseded.push(
        ...buildSuperseded('evals', EVAL_PERSONAS, ctx.existingRecordIds.get(EVAL_PERSONAS)),
      );
      superseded.push(
        ...buildSuperseded('evals', EVAL_EVALUATORS, ctx.existingRecordIds.get(EVAL_EVALUATORS)),
      );
    } else if (ctx.conflictStrategy === 'merge' && ctx.existingRecordIds) {
      superseded.push(
        ...buildMatchingSuperseded(
          'evals',
          EVAL_SETS,
          ctx.existingRecordIds.get(EVAL_SETS),
          records.filter((record) => record.collection === EVAL_SETS),
          'name',
        ),
      );
      superseded.push(
        ...buildMatchingSuperseded(
          'evals',
          EVAL_SCENARIOS,
          ctx.existingRecordIds.get(EVAL_SCENARIOS),
          records.filter((record) => record.collection === EVAL_SCENARIOS),
          'name',
        ),
      );
      superseded.push(
        ...buildMatchingSuperseded(
          'evals',
          EVAL_PERSONAS,
          ctx.existingRecordIds.get(EVAL_PERSONAS),
          records.filter((record) => record.collection === EVAL_PERSONAS),
          'name',
        ),
      );
      superseded.push(
        ...buildMatchingSuperseded(
          'evals',
          EVAL_EVALUATORS,
          ctx.existingRecordIds.get(EVAL_EVALUATORS),
          records.filter((record) => record.collection === EVAL_EVALUATORS),
          'name',
        ),
      );
    }

    log.info('Evals layer disassembled', {
      projectId: ctx.projectId,
      sets: evalSetDataMap.size,
      scenarios: records.filter((r) => r.collection === EVAL_SCENARIOS).length,
      personas: records.filter((r) => r.collection === EVAL_PERSONAS).length,
      evaluators: records.filter((r) => r.collection === EVAL_EVALUATORS).length,
    });

    return { records, superseded, warnings };
  }
}
