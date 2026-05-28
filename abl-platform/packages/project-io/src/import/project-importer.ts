/**
 * Project Importer — main orchestrator for importing projects
 *
 * Reads folder structure, validates syntax and dependencies,
 * computes diffs, and optionally applies changes.
 */

import type { ImportOptions, ImportPreview } from '../types.js';
import type { ProjectIOMcpServerConfig } from '../mcp-server-config-io.js';
import type { ProjectIOPromptLibraryBundle } from '../prompt-library-io.js';
import { readFolder, extractAgentName } from './folder-reader.js';
import { stripCommonPrefix } from './path-normalizer.js';
import { validateManifest } from './manifest-validator.js';
import { validateImport } from './import-validator.js';
import {
  computeApplyOperations,
  type ApplyOperation,
  computeToolApplyOperations,
  type ToolApplyOperation,
} from './import-applier.js';
import { extractToolsFromFiles } from './tool-extractor.js';
import { calculateImportDiffs } from '../diff/import-diff-calculator.js';

export interface ImportResult {
  success: boolean;
  preview: ImportPreview;
  operations: ApplyOperation[];
  toolOperations: ToolApplyOperation[];
  error?: { code: string; message: string };
}

export interface ExistingProjectState {
  agents: Map<
    string,
    {
      name: string;
      dslContent: string | null;
      systemPromptLibraryRef?: {
        promptId: string;
        versionId: string;
        resolvedHash?: string;
      } | null;
    }
  >;
  toolFiles: Map<string, string>;
  /** Individual tool records from ProjectTool collection (name → dslContent) */
  tools?: Map<string, { name: string; dslContent: string }>;
  /** Imported/exported MCP server configs participating in direct apply */
  mcpServers?: Map<string, { name: string; config: ProjectIOMcpServerConfig }>;
  /** Imported/exported prompt bundles keyed by promptId for direct apply/snapshot paths */
  prompts?: Map<string, ProjectIOPromptLibraryBundle>;
  localeFiles?: Map<string, string>;
  /** Locale assets with metadata for snapshot/revert and richer direct-apply diffs */
  locales?: Map<string, { filePath: string; value: string; description: string | null }>;
  profileFiles?: Map<string, string>;
}

/**
 * Import a project from a file map.
 *
 * @param files - Map of relativePath → content
 * @param existingState - Current project state for diffing
 * @param _options - Import configuration
 * @returns Import result with preview and operations
 */
export function importProject(
  files: Map<string, string>,
  existingState: ExistingProjectState,
  _options: ImportOptions,
): ImportResult {
  // Step 1: Read folder structure
  const { files: normalizedFiles } = stripCommonPrefix(files);
  const folderResult = readFolder(normalizedFiles);
  if (!folderResult.success) {
    return {
      success: false,
      preview: emptyPreview(folderResult.errors),
      operations: [],
      toolOperations: [],
      error: {
        code: 'INVALID_FOLDER',
        message: `Folder validation failed: ${folderResult.errors.join('; ')}`,
      },
    };
  }

  // Step 2: Validate manifest
  const manifestWarnings: string[] = [];
  if (folderResult.manifest) {
    const manifestResult = validateManifest(
      folderResult.manifest,
      new Set(folderResult.agentFiles.keys()),
      new Set(folderResult.toolFiles.keys()),
    );
    if (!manifestResult.valid) {
      return {
        success: false,
        preview: emptyPreview(manifestResult.errors),
        operations: [],
        toolOperations: [],
        error: {
          code: 'INVALID_MANIFEST',
          message: `Manifest validation failed: ${manifestResult.errors.join('; ')}`,
        },
      };
    }
    manifestWarnings.push(...manifestResult.warnings);
  }

  // Step 3: Validate syntax and dependencies
  const validationResult = validateImport(
    folderResult.agentFiles,
    folderResult.toolFiles,
    folderResult.profileFiles,
  );

  // Step 4: Build imported agents map (name → content)
  const importedAgents = new Map<
    string,
    {
      name: string;
      dslContent: string;
      description: string | null;
      systemPromptLibraryRef?: {
        promptId: string;
        versionId: string;
        resolvedHash?: string;
      } | null;
    }
  >();
  for (const [path, content] of folderResult.agentFiles) {
    const name =
      extractAgentName(content) ??
      path
        .split('/')
        .at(-1)!
        .replace(/\.agent\.(?:abl|yaml)$/, '');
    const description = folderResult.manifest?.agents[name]?.description ?? null;
    importedAgents.set(name, {
      name,
      dslContent: content,
      description,
      systemPromptLibraryRef: folderResult.manifest?.agents[name]?.systemPromptLibraryRef ?? null,
    });
  }

  // Step 4b: Extract individual tools from tool files
  const toolExtraction = extractToolsFromFiles(folderResult.toolFiles);
  const existingTools =
    existingState.tools ?? new Map<string, { name: string; dslContent: string }>();

  // Step 5: Compute diffs
  const existingDslMap = new Map<string, string>();
  for (const [name, agent] of existingState.agents) {
    if (agent.dslContent) {
      existingDslMap.set(name, agent.dslContent);
    }
  }
  const importedDslMap = new Map<string, string>();
  for (const [name, agent] of importedAgents) {
    importedDslMap.set(name, agent.dslContent);
  }

  const agentDiffs = calculateImportDiffs(existingDslMap, importedDslMap);

  // Step 6: Compute apply operations
  const operations = computeApplyOperations({
    existingAgents: existingState.agents,
    importedAgents,
  });

  // Step 6b: Compute tool apply operations
  const toolOperations = computeToolApplyOperations({
    existingTools,
    importedTools: toolExtraction.tools,
  });

  // Step 7: Build tool preview (name-level, not file-level)
  const importedToolNames = new Set(toolExtraction.tools.map((t) => t.name));
  const existingToolNames = new Set(existingTools.keys());

  const toolAdded = toolExtraction.tools
    .filter((t) => !existingToolNames.has(t.name))
    .map((t) => ({ name: t.name, toolType: t.toolType, sourceFile: t.sourceFile }));

  const toolModified = toolExtraction.tools
    .filter((t) => {
      const existing = existingTools.get(t.name);
      return existing && existing.dslContent !== t.dslContent;
    })
    .map((t) => ({ name: t.name, toolType: t.toolType, sourceFile: t.sourceFile }));

  const toolRemoved = [...existingToolNames].filter((name) => !importedToolNames.has(name));

  // Locale file diffs
  const existingLocales = existingState.localeFiles ?? new Map<string, string>();
  const localeAdded: string[] = [];
  const localeModified: string[] = [];
  const localeRemoved: string[] = [];
  for (const [path] of folderResult.localeFiles) {
    if (!existingLocales.has(path)) {
      localeAdded.push(path);
    } else if (existingLocales.get(path) !== folderResult.localeFiles.get(path)) {
      localeModified.push(path);
    }
  }
  for (const path of existingLocales.keys()) {
    if (!folderResult.localeFiles.has(path)) {
      localeRemoved.push(path);
    }
  }

  // Profile file diffs
  const existingProfiles = existingState.profileFiles ?? new Map<string, string>();
  const profileAdded: string[] = [];
  const profileModified: string[] = [];
  const profileRemoved: string[] = [];
  for (const [path] of folderResult.profileFiles) {
    if (!existingProfiles.has(path)) {
      profileAdded.push(path);
    } else if (existingProfiles.get(path) !== folderResult.profileFiles.get(path)) {
      profileModified.push(path);
    }
  }
  for (const path of existingProfiles.keys()) {
    if (!folderResult.profileFiles.has(path)) {
      profileRemoved.push(path);
    }
  }

  const preview: ImportPreview = {
    valid: validationResult.valid,
    changes: {
      agents: {
        added: agentDiffs.filter((d) => d.status === 'added').map((d) => d.name),
        modified: agentDiffs
          .filter((d) => d.status === 'modified' && d.diff)
          .map((d) => ({ name: d.name, diff: d.diff! })),
        removed: agentDiffs.filter((d) => d.status === 'removed').map((d) => d.name),
        unchanged: agentDiffs.filter((d) => d.status === 'unchanged').map((d) => d.name),
      },
      tools: {
        added: toolAdded,
        modified: toolModified,
        removed: toolRemoved,
      },
      locales: {
        added: localeAdded,
        modified: localeModified,
        removed: localeRemoved,
      },
      profiles: {
        added: profileAdded,
        modified: profileModified,
        removed: profileRemoved,
      },
    },
    dependencyValidation: validationResult.dependencyValidation,
    syntaxErrors: validationResult.syntaxErrors,
    warnings: manifestWarnings,
  };

  return {
    success: validationResult.valid,
    preview,
    operations,
    toolOperations,
  };
}

function emptyPreview(errors: string[]): ImportPreview {
  return {
    valid: false,
    changes: {
      agents: { added: [], modified: [], removed: [], unchanged: [] },
      tools: { added: [], modified: [], removed: [] },
      locales: { added: [], modified: [], removed: [] },
      profiles: { added: [], modified: [], removed: [] },
    },
    dependencyValidation: { valid: true, missing: [], circular: [] },
    syntaxErrors: [],
    warnings: errors,
  };
}
