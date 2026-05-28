/**
 * Import Applier — applies validated import changes to the data store
 *
 * This module provides a pure function that computes the operations needed
 * to apply an import. The actual DB writes are performed by the caller
 * (typically a Studio API route) to keep this package DB-agnostic for testing.
 */

import type { AgentPromptLibraryRefSnapshot } from '../agent-companion-metadata.js';

export interface ApplyOperation {
  type: 'create' | 'update' | 'delete';
  agentName: string;
  dslContent: string | null;
  description: string | null;
  systemPromptLibraryRef?: AgentPromptLibraryRefSnapshot | null;
}

interface ApplyAgentInput {
  name: string;
  dslContent: string | null;
  description?: string | null;
  systemPromptLibraryRef?: AgentPromptLibraryRefSnapshot | null;
}

export interface ApplyInput {
  existingAgents: Map<string, ApplyAgentInput>;
  importedAgents: Map<string, ApplyAgentInput & { dslContent: string; description: string | null }>;
}

function clonePromptRef(
  ref: AgentPromptLibraryRefSnapshot | null | undefined,
): AgentPromptLibraryRefSnapshot | null {
  return ref ? { ...ref } : null;
}

function promptRefsEqual(
  left: AgentPromptLibraryRefSnapshot | null | undefined,
  right: AgentPromptLibraryRefSnapshot | null | undefined,
): boolean {
  return (
    (left?.promptId ?? null) === (right?.promptId ?? null) &&
    (left?.versionId ?? null) === (right?.versionId ?? null) &&
    (left?.resolvedHash ?? null) === (right?.resolvedHash ?? null)
  );
}

/**
 * Compute the operations needed to apply an import.
 *
 * @param input - Existing project state and imported agents
 * @returns Array of operations to apply
 */
export function computeApplyOperations(input: ApplyInput): ApplyOperation[] {
  const operations: ApplyOperation[] = [];
  const { existingAgents, importedAgents } = input;

  // New agents (in import but not in existing)
  for (const [name, imported] of importedAgents) {
    if (!existingAgents.has(name)) {
      operations.push({
        type: 'create',
        agentName: name,
        dslContent: imported.dslContent,
        description: imported.description,
        systemPromptLibraryRef: clonePromptRef(imported.systemPromptLibraryRef),
      });
    }
  }

  // Modified agents (in both but content differs)
  for (const [name, imported] of importedAgents) {
    const existing = existingAgents.get(name);
    if (
      existing &&
      (existing.dslContent !== imported.dslContent ||
        (existing.description ?? null) !== imported.description ||
        !promptRefsEqual(existing.systemPromptLibraryRef, imported.systemPromptLibraryRef))
    ) {
      operations.push({
        type: 'update',
        agentName: name,
        dslContent: imported.dslContent,
        description: imported.description,
        systemPromptLibraryRef: clonePromptRef(imported.systemPromptLibraryRef),
      });
    }
  }

  // Removed agents (in existing but not in import)
  for (const [name] of existingAgents) {
    if (!importedAgents.has(name)) {
      operations.push({
        type: 'delete',
        agentName: name,
        dslContent: null,
        description: null,
        systemPromptLibraryRef: null,
      });
    }
  }

  return operations;
}

// ─── Tool Apply Operations ─────────────────────────────────────────────────

import type { ExtractedTool } from './tool-extractor.js';

export interface ToolApplyOperation {
  type: 'create' | 'update' | 'delete';
  toolName: string;
  toolType: string | null;
  dslContent: string | null;
  description: string | null;
  sourceHash: string | null;
  sourceFile: string | null;
}

export interface ToolApplyInput {
  existingTools: Map<string, { name: string; dslContent: string | null }>;
  importedTools: ExtractedTool[];
}

/**
 * Compute the operations needed to apply a tool import.
 *
 * @param input - Existing project tools and imported tools
 * @returns Array of tool operations to apply
 */
export function computeToolApplyOperations(input: ToolApplyInput): ToolApplyOperation[] {
  const operations: ToolApplyOperation[] = [];
  const { existingTools, importedTools } = input;

  // Build a map of imported tools by name for efficient lookup
  const importedByName = new Map<string, ExtractedTool>();
  for (const tool of importedTools) {
    importedByName.set(tool.name, tool);
  }

  // New tools (in imported but not in existing)
  for (const tool of importedTools) {
    if (!existingTools.has(tool.name)) {
      operations.push({
        type: 'create',
        toolName: tool.name,
        toolType: tool.toolType,
        dslContent: tool.dslContent,
        description: tool.description,
        sourceHash: tool.sourceHash,
        sourceFile: tool.sourceFile,
      });
    }
  }

  // Modified tools (in both but dslContent differs)
  for (const tool of importedTools) {
    const existing = existingTools.get(tool.name);
    if (existing && existing.dslContent !== tool.dslContent) {
      operations.push({
        type: 'update',
        toolName: tool.name,
        toolType: tool.toolType,
        dslContent: tool.dslContent,
        description: tool.description,
        sourceHash: tool.sourceHash,
        sourceFile: tool.sourceFile,
      });
    }
  }

  // Removed tools (in existing but not in imported)
  for (const [name] of existingTools) {
    if (!importedByName.has(name)) {
      operations.push({
        type: 'delete',
        toolName: name,
        toolType: null,
        dslContent: null,
        description: null,
        sourceHash: null,
        sourceFile: null,
      });
    }
  }

  return operations;
}
