import { compileABLtoIR, type AgentIR, type CompilerOptions } from '@abl/compiler';
import { isYamlFormat, parseAgentBasedABL, type AgentBasedDocument } from '@abl/core';
import { serializeToYAML } from '@abl/language-service';
import type { AgentArchiveFormat } from '../types.js';
import {
  resolvePromptLibraryRefOnDocument,
  type InjectedPromptLibraryRef,
} from '@agent-platform/shared/prompts';
import { parseBehaviorProfileDocumentsFromConfigVariables } from '../behavior-profile-documents.js';

export interface MaterializedAgentExport {
  content: string;
  format: AgentArchiveFormat;
  warnings: string[];
}

export interface ProjectAwareAgentExportSource {
  name: string;
  dslContent: string;
  systemPromptLibraryRef?: InjectedPromptLibraryRef | null;
}

export interface ProjectAwareAgentExportMaterializationInput {
  projectId: string;
  tenantId: string;
  agents: ProjectAwareAgentExportSource[];
  configVariables?: Record<string, string>;
  compilerOptions?: CompilerOptions;
}

function fallbackMaterializedAgentExport(
  agentName: string,
  dslContent: string,
  warnings: string[],
): MaterializedAgentExport {
  const sourceIsYaml = isYamlFormat(dslContent);

  if (sourceIsYaml) {
    return {
      content: dslContent,
      format: 'yaml',
      warnings: [
        ...warnings,
        `Kept existing YAML source for agent "${agentName}" because canonical YAML materialization was unavailable`,
      ],
    };
  }

  return {
    content: dslContent,
    format: 'abl',
    warnings: [
      ...warnings,
      `Exported agent "${agentName}" as .agent.abl because strict YAML was unavailable`,
    ],
  };
}

export function materializeAgentExport(
  agentName: string,
  dslContent: string,
): MaterializedAgentExport {
  const warnings: string[] = [];
  const sourceIsYaml = isYamlFormat(dslContent);

  try {
    const parsed = parseAgentBasedABL(dslContent);
    if (parsed.document && parsed.errors.length === 0) {
      const compiled = compileABLtoIR([parsed.document], { mode: 'preview' });
      const compiledAgent = compiled.agents[parsed.document.name];
      if (compiledAgent) {
        return {
          content: serializeToYAML(compiledAgent as unknown as Record<string, unknown>),
          format: 'yaml',
          warnings,
        };
      }
    }
  } catch (error) {
    warnings.push(
      `YAML materialization failed for agent "${agentName}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (sourceIsYaml) {
    return fallbackMaterializedAgentExport(agentName, dslContent, warnings);
  }

  return fallbackMaterializedAgentExport(agentName, dslContent, warnings);
}

interface PreparedProjectAwareAgentExportState {
  agent: ProjectAwareAgentExportSource;
  document?: AgentBasedDocument;
  warnings: string[];
}

export async function materializeProjectAgentExports(
  input: ProjectAwareAgentExportMaterializationInput,
): Promise<Map<string, MaterializedAgentExport>> {
  const preparedByName = new Map<string, PreparedProjectAwareAgentExportState>();
  const compilableDocuments: AgentBasedDocument[] = [];

  for (const agent of input.agents) {
    const warnings: string[] = [];
    try {
      const parsed = parseAgentBasedABL(agent.dslContent);

      if (!parsed.document || parsed.errors.length > 0) {
        if (parsed.errors.length > 0) {
          warnings.push(
            `YAML materialization failed for agent "${agent.name}": ${parsed.errors
              .map((error) => error.message)
              .join(', ')}`,
          );
        } else {
          warnings.push(
            `YAML materialization failed for agent "${agent.name}": parsed document was unavailable`,
          );
        }
        preparedByName.set(agent.name, { agent, warnings });
        continue;
      }

      if (agent.systemPromptLibraryRef) {
        const documentWithRef = parsed.document as AgentBasedDocument & {
          systemPrompt?: string | null;
          systemPromptLibraryRef?: InjectedPromptLibraryRef | null;
        };
        const originalPromptLibraryRef = { ...agent.systemPromptLibraryRef };
        documentWithRef.systemPromptLibraryRef = originalPromptLibraryRef;
        try {
          await resolvePromptLibraryRefOnDocument(documentWithRef, {
            tenantId: input.tenantId,
            projectId: input.projectId,
          });
          documentWithRef.systemPromptLibraryRef = originalPromptLibraryRef;
        } catch (error) {
          warnings.push(
            `YAML materialization failed for agent "${agent.name}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          preparedByName.set(agent.name, { agent, warnings });
          continue;
        }
      }

      preparedByName.set(agent.name, {
        agent,
        document: parsed.document,
        warnings,
      });
      compilableDocuments.push(parsed.document);
    } catch (error) {
      warnings.push(
        `YAML materialization failed for agent "${agent.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      preparedByName.set(agent.name, { agent, warnings });
    }
  }

  const configVariables =
    input.configVariables && Object.keys(input.configVariables).length > 0
      ? input.configVariables
      : undefined;
  const profileDocuments = configVariables
    ? parseBehaviorProfileDocumentsFromConfigVariables(configVariables)
    : { documents: [], errors: [] };

  let compiledAgents: Record<string, AgentIR> = {};
  let compilationFailure: string | null = null;
  if (compilableDocuments.length > 0) {
    try {
      const compilerOptions: CompilerOptions = {
        ...(input.compilerOptions ?? {}),
        mode: 'preview',
      };
      if (configVariables) {
        compilerOptions.config_variables = configVariables;
      }
      const output = compileABLtoIR(
        [...compilableDocuments, ...profileDocuments.documents],
        compilerOptions,
      );
      compiledAgents = output.agents;
    } catch (error) {
      compilationFailure = `Project-aware YAML materialization failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  const results = new Map<string, MaterializedAgentExport>();
  for (const agent of input.agents) {
    const prepared = preparedByName.get(agent.name) ?? { agent, warnings: [] };
    const warnings = [...prepared.warnings, ...profileDocuments.errors];
    if (compilationFailure) {
      warnings.push(compilationFailure);
    }

    if (prepared.document && !compilationFailure) {
      const compiledAgent = compiledAgents[prepared.document.name];
      if (compiledAgent) {
        results.set(agent.name, {
          content: serializeToYAML(compiledAgent as unknown as Record<string, unknown>),
          format: 'yaml',
          warnings,
        });
        continue;
      }

      warnings.push(
        `Project-aware YAML materialization did not produce agent "${prepared.document.name}"`,
      );
    }

    results.set(
      agent.name,
      fallbackMaterializedAgentExport(agent.name, agent.dslContent, warnings),
    );
  }

  return results;
}
