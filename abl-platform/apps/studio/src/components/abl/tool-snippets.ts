import { parseSignatureLine } from '@agent-platform/shared/tools';

import type { ToolWithVersion } from '../../store/tool-store';

type ToolSnippetSource = Pick<ToolWithVersion, 'name' | 'description' | 'toolType' | 'dslContent'>;

export function buildToolSignatureSnippet(tool: ToolSnippetSource): string {
  const signatureLine = tool.dslContent.split('\n')[0]?.trim();
  const { parameters, returnType } = parseSignatureLine(tool.dslContent);
  const params = parameters
    .map((param) => `${param.name}${param.required ? '' : '?'}: ${param.type}`)
    .join(', ');

  let snippet = `  ${signatureLine || `${tool.name}(${params}) -> ${returnType}`}`;
  if (tool.description) {
    snippet += `\n    description: "${tool.description.replace(/"/g, '\\"')}"`;
  }
  snippet += `\n    type: ${tool.toolType}`;

  return snippet;
}

export function buildMountedModuleToolName(alias: string, name: string): string {
  return `${alias}__${name}`;
}

export function buildImportedToolReferenceSnippet(alias: string, name: string): string {
  return `  ${buildMountedModuleToolName(alias, name)}()`;
}
