import type { ModuleReleaseContract } from '@agent-platform/database/models';

interface NameLookupModel {
  find(query: Record<string, unknown>): {
    select(fields: string): {
      lean(): Promise<Array<{ name: string }>>;
    };
  };
}

export interface MountedSymbolNames {
  agents: string[];
  tools: string[];
}

export interface MountedSymbolCollision {
  mountedName: string;
  conflictsWith: string;
}

export function buildMountedSymbolNames(
  alias: string,
  contract: Pick<ModuleReleaseContract, 'providedAgents' | 'providedTools'>,
): MountedSymbolNames {
  return {
    agents: (contract.providedAgents ?? []).map((agent) => `${alias}__${agent.name}`),
    tools: (contract.providedTools ?? []).map((tool) => `${alias}__${tool.name}`),
  };
}

function collectMountedSymbolEntries(mountedSymbols: MountedSymbolNames): Array<{
  mountedName: string;
  sourceKind: 'agent' | 'tool';
}> {
  return [
    ...mountedSymbols.agents.map((mountedName) => ({
      mountedName,
      sourceKind: 'agent' as const,
    })),
    ...mountedSymbols.tools.map((mountedName) => ({
      mountedName,
      sourceKind: 'tool' as const,
    })),
  ];
}

function collectInternalMountedSymbolCollisions(
  mountedSymbols: MountedSymbolNames,
): MountedSymbolCollision[] {
  const seen = new Map<string, string>();
  const collisions: MountedSymbolCollision[] = [];

  for (const entry of collectMountedSymbolEntries(mountedSymbols)) {
    const currentSource = `${entry.sourceKind}:${entry.mountedName}`;
    const existingSource = seen.get(entry.mountedName);
    if (existingSource) {
      collisions.push({
        mountedName: entry.mountedName,
        conflictsWith: `${existingSource},${currentSource}`,
      });
      continue;
    }

    seen.set(entry.mountedName, currentSource);
  }

  return collisions;
}

export async function findMountedSymbolCollisions(params: {
  tenantId: string;
  projectId: string;
  alias: string;
  contract: Pick<ModuleReleaseContract, 'providedAgents' | 'providedTools'>;
  ProjectAgent: NameLookupModel;
  ProjectTool: NameLookupModel;
}): Promise<{
  mountedSymbols: MountedSymbolNames;
  collisions: MountedSymbolCollision[];
}> {
  const mountedSymbols = buildMountedSymbolNames(params.alias, params.contract);
  const collisions: MountedSymbolCollision[] =
    collectInternalMountedSymbolCollisions(mountedSymbols);
  const allMountedNames = collectMountedSymbolEntries(mountedSymbols).map(
    (entry) => entry.mountedName,
  );

  if (allMountedNames.length > 0) {
    const existingAgents = await params.ProjectAgent.find({
      tenantId: params.tenantId,
      projectId: params.projectId,
      name: { $in: allMountedNames },
    })
      .select('name')
      .lean();
    for (const agent of existingAgents) {
      collisions.push({
        mountedName: agent.name,
        conflictsWith: `agent:${agent.name}`,
      });
    }
  }

  if (allMountedNames.length > 0) {
    const existingTools = await params.ProjectTool.find({
      tenantId: params.tenantId,
      projectId: params.projectId,
      name: { $in: allMountedNames },
    })
      .select('name')
      .lean();
    for (const tool of existingTools) {
      collisions.push({
        mountedName: tool.name,
        conflictsWith: `tool:${tool.name}`,
      });
    }
  }

  return { mountedSymbols, collisions };
}
