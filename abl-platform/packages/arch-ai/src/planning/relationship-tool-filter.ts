const RELATIONSHIP_TOOL_VERBS = new Set([
  'ask',
  'call',
  'consult',
  'delegate',
  'handoff',
  'invoke',
  'route',
  'transfer',
]);

const RELATIONSHIP_TARGET_SUFFIXES = new Set([
  'agent',
  'advisor',
  'bot',
  'router',
  'specialist',
  'supervisor',
]);

export function filterRelationshipToolRefs<T>(
  tools: ReadonlyArray<T>,
  relationshipTargets: ReadonlyArray<string>,
  getRef: (tool: T) => string,
): T[] {
  if (tools.length === 0 || relationshipTargets.length === 0) {
    return [...tools];
  }

  const targetAliases = buildRelationshipTargetAliases(relationshipTargets);
  return tools.filter((tool) => !isRelationshipToolRefForAliases(getRef(tool), targetAliases));
}

export function isRelationshipToolRef(
  toolName: string,
  relationshipTargets: ReadonlyArray<string>,
): boolean {
  return isRelationshipToolRefForAliases(
    toolName,
    buildRelationshipTargetAliases(relationshipTargets),
  );
}

function isRelationshipToolRefForAliases(
  toolName: string,
  targetAliases: ReadonlySet<string>,
): boolean {
  const parts = splitNameParts(toolName);
  const first = parts[0];
  if (!first || !RELATIONSHIP_TOOL_VERBS.has(first)) {
    return false;
  }

  const targetParts = parts[1] === 'to' ? parts.slice(2) : parts.slice(1);
  const targetAlias = targetParts.join('_');
  return targetAlias.length > 0 && targetAliases.has(targetAlias);
}

function buildRelationshipTargetAliases(targets: ReadonlyArray<string>): Set<string> {
  const aliases = new Set<string>();
  for (const target of targets) {
    const parts = splitNameParts(target);
    addAlias(aliases, parts);
    const withoutSuffix = trimTargetSuffix(parts);
    addAlias(aliases, withoutSuffix);
  }
  return aliases;
}

function trimTargetSuffix(parts: ReadonlyArray<string>): string[] {
  if (parts.length <= 1) {
    return [...parts];
  }
  const last = parts[parts.length - 1];
  if (last && RELATIONSHIP_TARGET_SUFFIXES.has(last)) {
    return parts.slice(0, -1);
  }
  return [...parts];
}

function addAlias(aliases: Set<string>, parts: ReadonlyArray<string>): void {
  const alias = parts.join('_');
  if (alias.length > 0) {
    aliases.add(alias);
  }
}

function splitNameParts(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}
