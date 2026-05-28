/**
 * useImportedSymbols Hook
 *
 * Derives imported agent and tool symbols from module dependencies.
 * Used by authoring surfaces (ABLSymbolTree, ToolPickerDialog, CoordinationSection)
 * to display imported read-only symbols with provenance info.
 */

import { useMemo } from 'react';
import { useModuleStore } from '../store/module-store';

export interface ImportedAgent {
  name: string;
  alias: string;
  moduleProjectName: string;
  dependencyId: string;
  description?: string;
  resolvedVersion?: string;
  // Enriched fields from ModuleReleaseContract
  mode?: string;
  tools?: string[];
  handoffTargets?: string[];
  delegateTargets?: string[];
  hasGather?: boolean;
  hasFlow?: boolean;
}

export interface ImportedTool {
  name: string;
  alias: string;
  moduleProjectName: string;
  dependencyId: string;
  description?: string;
  toolType?: string;
  resolvedVersion?: string;
  // Enriched fields from ModuleReleaseContract
  parameters?: Array<{ name: string; type: string; required: boolean; description?: string }>;
  returnType?: string;
  endpoint?: string;
  method?: string;
  authProfileRef?: string;
  requiredEnvVars?: string[];
}

export interface ImportedSymbols {
  agents: ImportedAgent[];
  tools: ImportedTool[];
  hasDependencies: boolean;
}

export function useImportedSymbols(): ImportedSymbols {
  const dependencies = useModuleStore((s) => s.dependencies);

  return useMemo(() => {
    const agents: ImportedAgent[] = [];
    const tools: ImportedTool[] = [];

    for (const dep of dependencies) {
      const contract = dep.contractSnapshot;
      if (!contract) continue;

      if (contract.providedAgents) {
        for (const agent of contract.providedAgents) {
          const agentRecord = agent as Record<string, unknown>;
          agents.push({
            name: agent.name,
            alias: dep.alias,
            moduleProjectName: dep.moduleProjectName,
            dependencyId: dep.id,
            description: agentRecord.description as string | undefined,
            resolvedVersion: dep.resolvedVersion || undefined,
            mode: agentRecord.mode as string | undefined,
            tools: agentRecord.tools as string[] | undefined,
            handoffTargets: agentRecord.handoffTargets as string[] | undefined,
            delegateTargets: agentRecord.delegateTargets as string[] | undefined,
            hasGather: agentRecord.hasGather as boolean | undefined,
            hasFlow: agentRecord.hasFlow as boolean | undefined,
          });
        }
      }

      if (contract.providedTools) {
        for (const tool of contract.providedTools) {
          const toolRecord = tool as Record<string, unknown>;
          tools.push({
            name: tool.name,
            alias: dep.alias,
            moduleProjectName: dep.moduleProjectName,
            dependencyId: dep.id,
            description: toolRecord.description as string | undefined,
            toolType: toolRecord.toolType as string | undefined,
            resolvedVersion: dep.resolvedVersion || undefined,
            parameters: toolRecord.parameters as ImportedTool['parameters'],
            returnType: toolRecord.returnType as string | undefined,
            endpoint: toolRecord.endpoint as string | undefined,
            method: toolRecord.method as string | undefined,
            authProfileRef: toolRecord.authProfileRef as string | undefined,
            requiredEnvVars: toolRecord.requiredEnvVars as string[] | undefined,
          });
        }
      }
    }

    return { agents, tools, hasDependencies: dependencies.length > 0 };
  }, [dependencies]);
}
