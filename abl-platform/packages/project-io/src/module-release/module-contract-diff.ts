/**
 * Module Contract Diff
 *
 * Compares two ModuleReleaseContracts and produces a structured diff with
 * breaking-change classification. Used by the upgrade preview endpoint to
 * show users what changes between the currently pinned release and the
 * upgrade target.
 *
 * Classification rules:
 * - Removed agents/tools → breaking (consumers may reference them)
 * - New required prereqs (envVars, authProfiles, connectors, mcpServers, configKeys) → breaking
 * - Added agents/tools → non-breaking (additive)
 * - Removed prereqs → non-breaking (fewer requirements)
 * - Changed descriptions or other metadata → warn
 */

import type { ModuleReleaseContract } from '@agent-platform/database/models';

// ─── Types ──────────────────────────────────────────────────────────────

export interface ContractDiffEntry {
  name: string;
  change: 'added' | 'removed' | 'modified';
  severity: 'breaking' | 'non-breaking' | 'warn';
  detail?: string;
}

export interface ModuleContractDiff {
  agents: ContractDiffEntry[];
  tools: ContractDiffEntry[];
  configKeys: ContractDiffEntry[];
  envVars: ContractDiffEntry[];
  secrets: ContractDiffEntry[];
  authProfiles: ContractDiffEntry[];
  connectors: ContractDiffEntry[];
  mcpServers: ContractDiffEntry[];
  warnings: ContractDiffEntry[];
  hasBreakingChanges: boolean;
  summary: string;
}

// ─── Empty contract fallback ──────────────────────────────────────────────

/**
 * Empty contract used as a safe fallback when a dependency's
 * `contractSnapshot` is null (pre-Phase-2 dependencies).
 */
export const EMPTY_MODULE_CONTRACT: ModuleReleaseContract = {
  providedAgents: [],
  providedTools: [],
  requiredConfigKeys: [],
  requiredEnvVars: [],
  requiredSecrets: [],
  requiredAuthProfiles: [],
  requiredConnectors: [],
  requiredMcpServers: [],
  warnings: [],
};

// ─── Main diff function ─────────────────────────────────────────────────

/**
 * Compute a structured diff between two module release contracts.
 *
 * @param current - The contract of the currently-pinned release
 * @param target  - The contract of the upgrade target release
 * @returns A ModuleContractDiff describing all changes with severity classification
 */
export function diffModuleContracts(
  current: ModuleReleaseContract,
  target: ModuleReleaseContract,
): ModuleContractDiff {
  const agents = diffProvidedAgents(current, target);
  const tools = diffProvidedTools(current, target);
  const configKeys = diffConfigKeys(current, target);
  const envVars = diffNamedItems(
    current.requiredEnvVars,
    target.requiredEnvVars,
    'required prerequisite',
  );
  const secrets = diffSecretItems(current.requiredSecrets ?? [], target.requiredSecrets ?? []);
  const authProfiles = diffNamedItems(
    current.requiredAuthProfiles,
    target.requiredAuthProfiles,
    'required prerequisite',
  );
  const connectors = diffNamedItems(
    current.requiredConnectors,
    target.requiredConnectors,
    'required prerequisite',
  );
  const mcpServers = diffNamedItems(
    current.requiredMcpServers,
    target.requiredMcpServers,
    'required prerequisite',
  );

  // Collect all entries across categories for summary
  const allEntries = [
    ...agents,
    ...tools,
    ...configKeys,
    ...envVars,
    ...secrets,
    ...authProfiles,
    ...connectors,
    ...mcpServers,
  ];

  const warnings = allEntries.filter((e) => e.severity === 'warn');
  const hasBreakingChanges = allEntries.some((e) => e.severity === 'breaking');

  const breakingCount = allEntries.filter((e) => e.severity === 'breaking').length;
  const nonBreakingCount = allEntries.filter((e) => e.severity === 'non-breaking').length;
  const warnCount = warnings.length;
  const summary = buildSummary(breakingCount, nonBreakingCount, warnCount);

  return {
    agents,
    tools,
    configKeys,
    envVars,
    secrets,
    authProfiles,
    connectors,
    mcpServers,
    warnings,
    hasBreakingChanges,
    summary,
  };
}

// ─── Provided agents diff ───────────────────────────────────────────────

function diffProvidedAgents(
  current: ModuleReleaseContract,
  target: ModuleReleaseContract,
): ContractDiffEntry[] {
  const entries: ContractDiffEntry[] = [];

  const currentMap = new Map(current.providedAgents.map((a) => [a.name, a]));
  const targetMap = new Map(target.providedAgents.map((a) => [a.name, a]));

  // Removed agents → breaking
  for (const [name, agent] of currentMap) {
    if (!targetMap.has(name)) {
      entries.push({
        name,
        change: 'removed',
        severity: 'breaking',
        detail: `Agent "${name}" removed${agent.description ? ` (was: ${agent.description})` : ''}`,
      });
    }
  }

  // Added agents → non-breaking
  for (const [name] of targetMap) {
    if (!currentMap.has(name)) {
      entries.push({
        name,
        change: 'added',
        severity: 'non-breaking',
        detail: `Agent "${name}" added`,
      });
    }
  }

  // Modified agents (description changed) → warn
  for (const [name, currentAgent] of currentMap) {
    const targetAgent = targetMap.get(name);
    if (targetAgent) {
      const currentDesc = currentAgent.description ?? '';
      const targetDesc = targetAgent.description ?? '';
      if (currentDesc !== targetDesc) {
        entries.push({
          name,
          change: 'modified',
          severity: 'warn',
          detail: `Agent "${name}" description changed`,
        });
      }
    }
  }

  return entries;
}

// ─── Provided tools diff ────────────────────────────────────────────────

function diffProvidedTools(
  current: ModuleReleaseContract,
  target: ModuleReleaseContract,
): ContractDiffEntry[] {
  const entries: ContractDiffEntry[] = [];

  const currentMap = new Map(current.providedTools.map((t) => [t.name, t]));
  const targetMap = new Map(target.providedTools.map((t) => [t.name, t]));

  // Removed tools → breaking
  for (const [name] of currentMap) {
    if (!targetMap.has(name)) {
      entries.push({
        name,
        change: 'removed',
        severity: 'breaking',
        detail: `Tool "${name}" removed`,
      });
    }
  }

  // Added tools → non-breaking
  for (const [name] of targetMap) {
    if (!currentMap.has(name)) {
      entries.push({
        name,
        change: 'added',
        severity: 'non-breaking',
        detail: `Tool "${name}" added`,
      });
    }
  }

  // Modified tools (toolType changed) → warn
  for (const [name, currentTool] of currentMap) {
    const targetTool = targetMap.get(name);
    if (targetTool && currentTool.toolType !== targetTool.toolType) {
      entries.push({
        name,
        change: 'modified',
        severity: 'warn',
        detail: `Tool "${name}" type changed from "${currentTool.toolType}" to "${targetTool.toolType}"`,
      });
    }
  }

  return entries;
}

// ─── Config keys diff ───────────────────────────────────────────────────

function diffConfigKeys(
  current: ModuleReleaseContract,
  target: ModuleReleaseContract,
): ContractDiffEntry[] {
  const entries: ContractDiffEntry[] = [];

  const currentMap = new Map(current.requiredConfigKeys.map((k) => [k.key, k]));
  const targetMap = new Map(target.requiredConfigKeys.map((k) => [k.key, k]));

  // New required config key → breaking
  for (const [key] of targetMap) {
    if (!currentMap.has(key)) {
      entries.push({
        name: key,
        change: 'added',
        severity: 'breaking',
        detail: `Config key "${key}" now required`,
      });
    }
  }

  // Removed config key → non-breaking
  for (const [key] of currentMap) {
    if (!targetMap.has(key)) {
      entries.push({
        name: key,
        change: 'removed',
        severity: 'non-breaking',
        detail: `Config key "${key}" no longer required`,
      });
    }
  }

  // Modified config key (isSecret changed) → warn
  for (const [key, currentKey] of currentMap) {
    const targetKey = targetMap.get(key);
    if (targetKey && currentKey.isSecret !== targetKey.isSecret) {
      const fromLabel = currentKey.isSecret ? 'secret' : 'non-secret';
      const toLabel = targetKey.isSecret ? 'secret' : 'non-secret';
      entries.push({
        name: key,
        change: 'modified',
        severity: 'warn',
        detail: `Config key "${key}" changed from ${fromLabel} to ${toLabel}`,
      });
    }
  }

  // Modified config key (description changed) → warn
  for (const [key, currentKey] of currentMap) {
    const targetKey = targetMap.get(key);
    if (targetKey) {
      const currentDesc = currentKey.description ?? '';
      const targetDesc = targetKey.description ?? '';
      if (currentDesc !== targetDesc && currentKey.isSecret === targetKey.isSecret) {
        entries.push({
          name: key,
          change: 'modified',
          severity: 'warn',
          detail: `Config key "${key}" description changed`,
        });
      }
    }
  }

  return entries;
}

function diffSecretItems(
  currentItems: NonNullable<ModuleReleaseContract['requiredSecrets']>,
  targetItems: NonNullable<ModuleReleaseContract['requiredSecrets']>,
): ContractDiffEntry[] {
  const entries: ContractDiffEntry[] = [];
  const keyFor = (item: { key: string; toolName?: string }) =>
    item.toolName ? `${item.toolName}:${item.key}` : item.key;
  const currentNames = new Set(currentItems.map(keyFor));
  const targetNames = new Set(targetItems.map(keyFor));

  for (const name of targetNames) {
    if (!currentNames.has(name)) {
      entries.push({
        name,
        change: 'added',
        severity: 'breaking',
        detail: `Runtime secret "${name}" now required`,
      });
    }
  }

  for (const name of currentNames) {
    if (!targetNames.has(name)) {
      entries.push({
        name,
        change: 'removed',
        severity: 'non-breaking',
        detail: `Runtime secret "${name}" no longer required`,
      });
    }
  }

  return entries;
}

// ─── Named items diff (env vars, auth profiles, connectors, MCP servers) ─

/**
 * Generic diff for named prerequisite items.
 * - Added → breaking (new requirement on consumers)
 * - Removed → non-breaking (fewer requirements)
 */
function diffNamedItems(
  currentItems: Array<{ name: string }>,
  targetItems: Array<{ name: string }>,
  itemLabel: string,
): ContractDiffEntry[] {
  const entries: ContractDiffEntry[] = [];

  const currentNames = new Set(currentItems.map((i) => i.name));
  const targetNames = new Set(targetItems.map((i) => i.name));

  // New required item → breaking
  for (const name of targetNames) {
    if (!currentNames.has(name)) {
      entries.push({
        name,
        change: 'added',
        severity: 'breaking',
        detail: `New ${itemLabel}: "${name}"`,
      });
    }
  }

  // Removed item → non-breaking
  for (const name of currentNames) {
    if (!targetNames.has(name)) {
      entries.push({
        name,
        change: 'removed',
        severity: 'non-breaking',
        detail: `${itemLabel.charAt(0).toUpperCase() + itemLabel.slice(1)} "${name}" no longer required`,
      });
    }
  }

  return entries;
}

// ─── Summary builder ────────────────────────────────────────────────────

function buildSummary(breakingCount: number, nonBreakingCount: number, warnCount: number): string {
  if (breakingCount === 0 && nonBreakingCount === 0 && warnCount === 0) {
    return 'No changes';
  }

  const parts: string[] = [];

  if (breakingCount > 0) {
    parts.push(`${breakingCount} breaking`);
  }
  if (nonBreakingCount > 0) {
    parts.push(`${nonBreakingCount} non-breaking`);
  }
  if (warnCount > 0) {
    parts.push(`${warnCount} warning${warnCount === 1 ? '' : 's'}`);
  }

  return `${parts.join(', ')} change${breakingCount + nonBreakingCount + warnCount === 1 ? '' : 's'}`;
}
