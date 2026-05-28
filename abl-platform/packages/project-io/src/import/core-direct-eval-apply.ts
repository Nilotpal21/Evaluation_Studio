import { createHash } from 'node:crypto';
import { classifyEvalFile } from './layer-disassemblers/evals-disassembler.js';

export type CoreImportEvalCollectionV2 =
  | 'eval_sets'
  | 'eval_scenarios'
  | 'eval_personas'
  | 'eval_evaluators';

export interface CoreImportEvalEntityStateV2 {
  name: string;
  data: Record<string, unknown>;
  sourceHash?: string | null;
  sourceFile?: string | null;
}

export interface CoreImportEvalSetStateV2 extends CoreImportEvalEntityStateV2 {
  scenarioNames: string[];
  personaNames: string[];
  evaluatorNames: string[];
}

export interface CoreImportEvalStateV2 {
  sets: Map<string, CoreImportEvalSetStateV2>;
  scenarios: Map<string, CoreImportEvalEntityStateV2>;
  personas: Map<string, CoreImportEvalEntityStateV2>;
  evaluators: Map<string, CoreImportEvalEntityStateV2>;
}

export interface CoreImportEvalOperationV2 {
  type: 'create' | 'update' | 'delete';
  collection: CoreImportEvalCollectionV2;
  name: string;
  data: Record<string, unknown> | null;
  sourceHash: string | null;
  sourceFile: string | null;
  scenarioNames?: string[];
  personaNames?: string[];
  evaluatorNames?: string[];
}

export type CoreImportEvalWriteOperationV2 = CoreImportEvalOperationV2 & {
  type: 'create' | 'update';
  data: Record<string, unknown>;
  sourceHash: string;
  sourceFile: string;
};

export type CoreImportCreatedEvalIdsV2 = Partial<Record<CoreImportEvalCollectionV2, string[]>>;

export interface CoreImportEvalOperationCountsV2 {
  evalsCreated: number;
  evalsUpdated: number;
  evalsDeleted: number;
}

const INTERNAL_EVAL_FIELDS = new Set([
  '_id',
  'id',
  '__v',
  'projectId',
  'tenantId',
  'createdAt',
  'updatedAt',
  'createdBy',
  'modifiedBy',
  'updatedBy',
  '_exportedId',
  '_parentSetName',
  '_nestedScenarioNames',
  '_nestedPersonaNames',
  '_nestedEvaluatorNames',
]);

export function createEmptyEvalState(): CoreImportEvalStateV2 {
  return {
    sets: new Map(),
    scenarios: new Map(),
    personas: new Map(),
    evaluators: new Map(),
  };
}

function computeSourceHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
    .join(',')}}`;
}

export function sanitizeEvalImportData(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (INTERNAL_EVAL_FIELDS.has(key)) {
      continue;
    }
    output[key] = value;
  }

  return output;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))];
}

function requireEvalName(filePath: string, data: Record<string, unknown>): string {
  if (typeof data.name === 'string' && data.name.trim().length > 0) {
    return data.name.trim();
  }

  throw new Error(`Eval file "${filePath}" is missing a non-empty name field`);
}

function parseEvalJson(filePath: string, content: string): Record<string, unknown> {
  const parsed = JSON.parse(content) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error(`Eval file "${filePath}" must contain a JSON object`);
  }
  return parsed;
}

function comparableEvalEntity(entity: CoreImportEvalEntityStateV2): Record<string, unknown> {
  return sanitizeEvalImportData(entity.data);
}

function comparableEvalSet(entity: CoreImportEvalSetStateV2): Record<string, unknown> {
  return {
    ...sanitizeEvalImportData(entity.data),
    scenarioNames: [...entity.scenarioNames].sort(),
    personaNames: [...entity.personaNames].sort(),
    evaluatorNames: [...entity.evaluatorNames].sort(),
  };
}

function hasEntityChanged(
  existing: CoreImportEvalEntityStateV2,
  imported: CoreImportEvalEntityStateV2,
): boolean {
  return (
    stableStringify(comparableEvalEntity(existing)) !==
    stableStringify(comparableEvalEntity(imported))
  );
}

function hasSetChanged(
  existing: CoreImportEvalSetStateV2,
  imported: CoreImportEvalSetStateV2,
): boolean {
  return (
    stableStringify(comparableEvalSet(existing)) !== stableStringify(comparableEvalSet(imported))
  );
}

function mergeUnique(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}

function buildEntityOperations(
  collection: CoreImportEvalCollectionV2,
  existing: Map<string, CoreImportEvalEntityStateV2>,
  imported: Map<string, CoreImportEvalEntityStateV2>,
  deleteUnmatched: boolean,
): CoreImportEvalOperationV2[] {
  const operations: CoreImportEvalOperationV2[] = [];

  for (const [name, importedEntity] of imported) {
    const existingEntity = existing.get(name);
    if (!existingEntity) {
      operations.push({
        type: 'create',
        collection,
        name,
        data: importedEntity.data,
        sourceHash:
          importedEntity.sourceHash ?? computeSourceHash(stableStringify(importedEntity.data)),
        sourceFile: importedEntity.sourceFile ?? '',
      });
      continue;
    }

    if (hasEntityChanged(existingEntity, importedEntity)) {
      operations.push({
        type: 'update',
        collection,
        name,
        data: importedEntity.data,
        sourceHash:
          importedEntity.sourceHash ?? computeSourceHash(stableStringify(importedEntity.data)),
        sourceFile: importedEntity.sourceFile ?? '',
      });
    }
  }

  if (deleteUnmatched) {
    for (const name of existing.keys()) {
      if (!imported.has(name)) {
        operations.push({
          type: 'delete',
          collection,
          name,
          data: null,
          sourceHash: null,
          sourceFile: null,
        });
      }
    }
  }

  return operations;
}

function buildSetOperations(
  existing: Map<string, CoreImportEvalSetStateV2>,
  imported: Map<string, CoreImportEvalSetStateV2>,
  deleteUnmatched: boolean,
): CoreImportEvalOperationV2[] {
  const operations: CoreImportEvalOperationV2[] = [];

  for (const [name, importedSet] of imported) {
    const existingSet = existing.get(name);
    if (!existingSet) {
      operations.push({
        type: 'create',
        collection: 'eval_sets',
        name,
        data: importedSet.data,
        sourceHash:
          importedSet.sourceHash ??
          computeSourceHash(stableStringify(comparableEvalSet(importedSet))),
        sourceFile: importedSet.sourceFile ?? '',
        scenarioNames: importedSet.scenarioNames,
        personaNames: importedSet.personaNames,
        evaluatorNames: importedSet.evaluatorNames,
      });
      continue;
    }

    if (hasSetChanged(existingSet, importedSet)) {
      operations.push({
        type: 'update',
        collection: 'eval_sets',
        name,
        data: importedSet.data,
        sourceHash:
          importedSet.sourceHash ??
          computeSourceHash(stableStringify(comparableEvalSet(importedSet))),
        sourceFile: importedSet.sourceFile ?? '',
        scenarioNames: importedSet.scenarioNames,
        personaNames: importedSet.personaNames,
        evaluatorNames: importedSet.evaluatorNames,
      });
    }
  }

  if (deleteUnmatched) {
    for (const name of existing.keys()) {
      if (!imported.has(name)) {
        operations.push({
          type: 'delete',
          collection: 'eval_sets',
          name,
          data: null,
          sourceHash: null,
          sourceFile: null,
        });
      }
    }
  }

  return operations;
}

export function buildEvalOperations(input: {
  existing: CoreImportEvalStateV2 | undefined;
  imported: CoreImportEvalStateV2;
  deleteUnmatched: boolean;
}): CoreImportEvalOperationV2[] {
  const existing = input.existing ?? createEmptyEvalState();

  return [
    ...buildEntityOperations(
      'eval_scenarios',
      existing.scenarios,
      input.imported.scenarios,
      input.deleteUnmatched,
    ),
    ...buildEntityOperations(
      'eval_personas',
      existing.personas,
      input.imported.personas,
      input.deleteUnmatched,
    ),
    ...buildEntityOperations(
      'eval_evaluators',
      existing.evaluators,
      input.imported.evaluators,
      input.deleteUnmatched,
    ),
    ...buildSetOperations(existing.sets, input.imported.sets, input.deleteUnmatched),
  ];
}

export function countEvalOperations(
  evalOperations: CoreImportEvalOperationV2[],
): CoreImportEvalOperationCountsV2 {
  return {
    evalsCreated: evalOperations.filter((operation) => operation.type === 'create').length,
    evalsUpdated: evalOperations.filter((operation) => operation.type === 'update').length,
    evalsDeleted: evalOperations.filter((operation) => operation.type === 'delete').length,
  };
}

export function buildEvalImportStateFromFiles(
  evalFiles: Map<string, string>,
): CoreImportEvalStateV2 {
  const state = createEmptyEvalState();
  const evaluatorOldIdToName = new Map<string, string>();
  const setDirectoryToName = new Map<string, string>();

  for (const [filePath, content] of evalFiles) {
    const classified = classifyEvalFile(filePath);
    if (classified.type !== 'evaluator') {
      continue;
    }

    const parsed = parseEvalJson(filePath, content);
    if (typeof parsed._exportedId === 'string' && typeof parsed.name === 'string') {
      evaluatorOldIdToName.set(parsed._exportedId, parsed.name);
    }
  }

  for (const [filePath, content] of evalFiles) {
    const classified = classifyEvalFile(filePath);
    if (classified.type !== 'eval-set' || !classified.setName) {
      continue;
    }

    const parsed = parseEvalJson(filePath, content);
    const name = requireEvalName(filePath, parsed);
    setDirectoryToName.set(classified.setName, name);

    const evaluatorNames = mergeUnique(
      readStringArray(parsed._nestedEvaluatorNames),
      Array.isArray(parsed.evaluatorIds)
        ? parsed.evaluatorIds.flatMap((id) => {
            const resolvedName = evaluatorOldIdToName.get(String(id));
            return resolvedName ? [resolvedName] : [];
          })
        : [],
    );

    const data = sanitizeEvalImportData({
      ...parsed,
      scenarioIds: [],
      personaIds: [],
      evaluatorIds: [],
    });

    state.sets.set(name, {
      name,
      data,
      sourceHash: computeSourceHash(content),
      sourceFile: filePath,
      scenarioNames: readStringArray(parsed._nestedScenarioNames),
      personaNames: readStringArray(parsed._nestedPersonaNames),
      evaluatorNames,
    });
  }

  for (const [filePath, content] of evalFiles) {
    const classified = classifyEvalFile(filePath);
    const parsed = classifyRequiresParsing(classified.type)
      ? parseEvalJson(filePath, content)
      : null;
    if (!parsed) {
      continue;
    }

    const name = requireEvalName(filePath, parsed);
    const data = sanitizeEvalImportData(parsed);

    if (classified.type === 'nested-scenario') {
      state.scenarios.set(name, {
        name,
        data,
        sourceHash: computeSourceHash(content),
        sourceFile: filePath,
      });
      const setName = classified.setName ? setDirectoryToName.get(classified.setName) : undefined;
      if (setName) {
        const setState = state.sets.get(setName);
        if (setState) {
          setState.scenarioNames = mergeUnique(setState.scenarioNames, [name]);
        }
      }
    } else if (classified.type === 'nested-persona') {
      state.personas.set(name, {
        name,
        data,
        sourceHash: computeSourceHash(content),
        sourceFile: filePath,
      });
      const setName = classified.setName ? setDirectoryToName.get(classified.setName) : undefined;
      if (setName) {
        const setState = state.sets.get(setName);
        if (setState) {
          setState.personaNames = mergeUnique(setState.personaNames, [name]);
        }
      }
    } else if (classified.type === 'standalone-scenario') {
      state.scenarios.set(name, {
        name,
        data,
        sourceHash: computeSourceHash(content),
        sourceFile: filePath,
      });
    } else if (classified.type === 'standalone-persona') {
      state.personas.set(name, {
        name,
        data,
        sourceHash: computeSourceHash(content),
        sourceFile: filePath,
      });
    } else if (classified.type === 'evaluator') {
      state.evaluators.set(name, {
        name,
        data,
        sourceHash: computeSourceHash(content),
        sourceFile: filePath,
      });
    }
  }

  return state;
}

function classifyRequiresParsing(type: ReturnType<typeof classifyEvalFile>['type']): boolean {
  return (
    type === 'nested-scenario' ||
    type === 'nested-persona' ||
    type === 'standalone-scenario' ||
    type === 'standalone-persona' ||
    type === 'evaluator'
  );
}
