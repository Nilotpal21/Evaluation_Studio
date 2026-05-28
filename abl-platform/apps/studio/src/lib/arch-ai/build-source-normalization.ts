import { sanitizeAblSections } from './quality-enrichment';

type MemoryValueType = 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';

interface NormalizedRememberTarget {
  originalTarget: string;
  normalizedTarget: string;
  type: MemoryValueType;
  needsDeclaration: boolean;
}

export interface BuildSourceNormalizationResult {
  code: string;
  repairs: string[];
}

const BARE_MEMORY_IDENTIFIER_PATTERN = /^[A-Za-z_]\w*$/;
const MEMORY_PATH_PATTERN = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const TEMPLATE_VALUE_PATTERN = /^\{\{.+\}\}$/;
const NUMERIC_VALUE_PATTERN = /^-?\d+(?:\.\d+)?$/;

function inferPersistentType(
  target: string,
  value: string,
  sessionVarTypes: Map<string, MemoryValueType | undefined>,
): MemoryValueType {
  const sessionType = sessionVarTypes.get(target);
  if (sessionType) {
    return sessionType;
  }

  const trimmedValue = value.trim();
  if (trimmedValue === 'true' || trimmedValue === 'false') {
    return 'boolean';
  }
  if (NUMERIC_VALUE_PATTERN.test(trimmedValue)) {
    return 'number';
  }
  if (TEMPLATE_VALUE_PATTERN.test(trimmedValue)) {
    return 'string';
  }

  return 'string';
}

function findMemorySectionBounds(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => /^MEMORY:\s*$/i.test(line.trim()));
  if (start === -1) {
    return null;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim().length === 0) {
      continue;
    }
    if (/^\S/.test(line)) {
      end = index;
      break;
    }
  }

  return { start, end };
}

function findMemorySubsectionIndex(
  lines: string[],
  bounds: { start: number; end: number },
  subsectionName: string,
): number {
  for (let index = bounds.start + 1; index < bounds.end; index++) {
    if (new RegExp(`^\\s+${subsectionName}:\\s*$`, 'i').test(lines[index])) {
      return index;
    }
  }
  return -1;
}

function getIndent(line: string): string {
  return line.match(/^\s*/)?.[0] ?? '';
}

function findSubsectionEnd(
  lines: string[],
  bounds: { start: number; end: number },
  subsectionIndex: number,
): number {
  const subsectionIndent = getIndent(lines[subsectionIndex]);

  for (let index = subsectionIndex + 1; index < bounds.end; index++) {
    const line = lines[index];
    if (line.trim().length === 0) {
      continue;
    }
    if (getIndent(line) === subsectionIndent && /^[A-Za-z_]+:\s*$/.test(line.trim())) {
      return index;
    }
  }

  return bounds.end;
}

function buildPersistentDeclarationLines(
  declarations: NormalizedRememberTarget[],
  subsectionIndent: string,
): string[] {
  const itemIndent = `${subsectionIndent}  `;
  const propertyIndent = `${itemIndent}  `;

  return declarations.flatMap((declaration) => [
    `${itemIndent}- path: ${declaration.normalizedTarget}`,
    `${propertyIndent}scope: user`,
    `${propertyIndent}access: readwrite`,
    `${propertyIndent}type: ${declaration.type}`,
  ]);
}

function applyRememberTargetRepairs(
  sanitizedCode: string,
  repairs: NormalizedRememberTarget[],
): string {
  if (repairs.length === 0) {
    return sanitizedCode;
  }

  const lines = sanitizedCode.split('\n');
  const bounds = findMemorySectionBounds(lines);
  if (!bounds) {
    return sanitizedCode;
  }

  const repairMap = new Map(
    repairs.map((repair) => [repair.originalTarget, repair.normalizedTarget]),
  );

  for (let index = bounds.start + 1; index < bounds.end; index++) {
    const targetMatch = lines[index].match(/^(\s*target:\s*)(['"]?)([^"'#\s]+)\2(\s*(?:#.*)?)$/);
    if (!targetMatch) {
      continue;
    }

    const normalizedTarget = repairMap.get(targetMatch[3]);
    if (!normalizedTarget || normalizedTarget === targetMatch[3]) {
      continue;
    }

    lines[index] =
      `${targetMatch[1]}${targetMatch[2]}${normalizedTarget}${targetMatch[2]}${targetMatch[4] ?? ''}`;
  }

  const persistentIndex = findMemorySubsectionIndex(lines, bounds, 'persistent');
  const persistentDeclarations = repairs
    .filter((repair) => repair.needsDeclaration)
    .filter(
      (repair, index, allRepairs) =>
        allRepairs.findIndex(
          (candidate) => candidate.normalizedTarget === repair.normalizedTarget,
        ) === index,
    );

  if (persistentDeclarations.length === 0) {
    return lines.join('\n');
  }

  if (persistentIndex !== -1) {
    const insertIndex = findSubsectionEnd(lines, bounds, persistentIndex);
    lines.splice(
      insertIndex,
      0,
      ...buildPersistentDeclarationLines(persistentDeclarations, getIndent(lines[persistentIndex])),
    );
    return lines.join('\n');
  }

  const insertAfter =
    findMemorySubsectionIndex(lines, bounds, 'session') !== -1
      ? findSubsectionEnd(lines, bounds, findMemorySubsectionIndex(lines, bounds, 'session'))
      : bounds.start + 1;
  const subsectionIndent =
    findMemorySubsectionIndex(lines, bounds, 'remember') !== -1
      ? getIndent(lines[findMemorySubsectionIndex(lines, bounds, 'remember')])
      : findMemorySubsectionIndex(lines, bounds, 'recall') !== -1
        ? getIndent(lines[findMemorySubsectionIndex(lines, bounds, 'recall')])
        : '  ';

  lines.splice(
    insertAfter,
    0,
    `${subsectionIndent}persistent:`,
    ...buildPersistentDeclarationLines(persistentDeclarations, subsectionIndent),
  );

  return lines.join('\n');
}

export async function normalizeBuildAgentSource(
  ablContent: string,
): Promise<BuildSourceNormalizationResult> {
  const sanitizedCode = sanitizeAblSections(ablContent);
  const { parseAgentBasedABL } = await import('@abl/core');
  const parseResult = parseAgentBasedABL(sanitizedCode);

  if (!parseResult.document || (parseResult.errors?.length ?? 0) > 0) {
    return { code: sanitizedCode, repairs: [] };
  }

  const memory = parseResult.document.memory;
  if (!memory || (memory.remember?.length ?? 0) === 0) {
    return { code: sanitizedCode, repairs: [] };
  }

  const persistentPaths = new Set((memory.persistent ?? []).map((path) => path.path));
  const sessionVarTypes = new Map(
    (memory.session ?? []).map((sessionVar) => [sessionVar.name, sessionVar.type]),
  );
  const rememberTargetRepairs: NormalizedRememberTarget[] = [];

  for (const rememberTrigger of memory.remember ?? []) {
    const originalTarget = rememberTrigger.store.target.trim();
    if (persistentPaths.has(originalTarget)) {
      continue;
    }

    const normalizedTarget = BARE_MEMORY_IDENTIFIER_PATTERN.test(originalTarget)
      ? `user.${originalTarget}`
      : originalTarget;

    if (!MEMORY_PATH_PATTERN.test(normalizedTarget)) {
      continue;
    }

    if (!persistentPaths.has(normalizedTarget)) {
      rememberTargetRepairs.push({
        originalTarget,
        normalizedTarget,
        type: inferPersistentType(originalTarget, rememberTrigger.store.value, sessionVarTypes),
        needsDeclaration: true,
      });
      persistentPaths.add(normalizedTarget);
      continue;
    }

    if (normalizedTarget !== originalTarget) {
      rememberTargetRepairs.push({
        originalTarget,
        normalizedTarget,
        type: inferPersistentType(originalTarget, rememberTrigger.store.value, sessionVarTypes),
        needsDeclaration: false,
      });
    }
  }

  if (rememberTargetRepairs.length === 0) {
    return { code: sanitizedCode, repairs: [] };
  }

  const normalizedCode = applyRememberTargetRepairs(sanitizedCode, rememberTargetRepairs);
  const repairs = rememberTargetRepairs.map((repair) =>
    repair.originalTarget === repair.normalizedTarget
      ? `Declared missing persistent memory path "${repair.normalizedTarget}" for REMEMBER target.`
      : !repair.needsDeclaration
        ? `Normalized REMEMBER target "${repair.originalTarget}" to existing persistent path "${repair.normalizedTarget}".`
        : `Normalized REMEMBER target "${repair.originalTarget}" to persistent path "${repair.normalizedTarget}" and declared it under MEMORY.persistent.`,
  );

  return { code: normalizedCode, repairs };
}
