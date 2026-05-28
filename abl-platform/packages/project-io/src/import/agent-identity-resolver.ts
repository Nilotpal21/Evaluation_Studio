import { validateAgentName } from '@agent-platform/shared';
import type { ProjectManifest, ProjectManifestV2, ImportEntryAgentResolution } from '../types.js';
import { normalizeAgentCompanionMetadata } from '../agent-companion-metadata.js';
import { extractAgentName } from './folder-reader.js';

type ManifestLike = Pick<ProjectManifest, 'agents' | 'entry_agent'> | ProjectManifestV2 | null;

export interface ResolvedImportedAgent {
  resolvedName: string;
  declaredName: string | null;
  manifestName: string | null;
  fileStem: string;
  sourceFile: string;
  dslContent: string;
  description: string | null;
  systemPromptLibraryRef?: {
    promptId: string;
    versionId: string;
    resolvedHash?: string;
  } | null;
  aliases: string[];
}

export interface ImportedAgentIdentityResolution {
  agents: Map<string, ResolvedImportedAgent>;
  aliasMap: Map<string, string>;
  ambiguousAliases: Set<string>;
  entryAgent: ImportEntryAgentResolution;
  warnings: string[];
  errors: string[];
}

function fileStemFromPath(path: string): string {
  return path
    .split('/')
    .at(-1)!
    .replace(/\.agent\.(?:abl|yaml)$/, '');
}

function normalizeManifest(manifest: ManifestLike): {
  agents: Record<
    string,
    {
      path: string;
      description: string | null;
      systemPromptLibraryRef?: ResolvedImportedAgent['systemPromptLibraryRef'];
    }
  >;
  entryAgent: string | null;
} {
  if (!manifest) {
    return { agents: {}, entryAgent: null };
  }

  const agents = Object.fromEntries(
    Object.entries(manifest.agents ?? {}).map(([name, record]) => [
      name,
      {
        path: record.path,
        description: record.description ?? null,
        systemPromptLibraryRef:
          normalizeAgentCompanionMetadata({
            systemPromptLibraryRef: record.systemPromptLibraryRef,
          })?.systemPromptLibraryRef ?? null,
      },
    ]),
  );

  return {
    agents,
    entryAgent: manifest.entry_agent ?? null,
  };
}

export function resolveImportedAgentIdentities(
  agentFiles: Map<string, string>,
  manifest: ManifestLike,
): ImportedAgentIdentityResolution {
  const warnings: string[] = [];
  const errors: string[] = [];
  const agents = new Map<string, ResolvedImportedAgent>();
  const aliasMap = new Map<string, string>();
  const ambiguousAliases = new Set<string>();
  const normalizedManifest = normalizeManifest(manifest);
  const manifestNameByPath = new Map<string, string>();

  for (const [name, record] of Object.entries(normalizedManifest.agents)) {
    manifestNameByPath.set(record.path, name);
  }

  for (const [path, content] of agentFiles) {
    const declaredName = extractAgentName(content);
    const manifestName = manifestNameByPath.get(path) ?? null;
    const fileStem = fileStemFromPath(path);
    const resolvedName = declaredName ?? manifestName ?? fileStem;
    const aliases = Array.from(
      new Set([resolvedName, declaredName, manifestName, fileStem].filter(Boolean) as string[]),
    );

    const nameError = validateAgentName(resolvedName);
    if (nameError) {
      errors.push(`Invalid imported agent name "${resolvedName}" from ${path}: ${nameError}`);
      continue;
    }

    const description =
      (manifestName ? normalizedManifest.agents[manifestName]?.description : null) ??
      normalizedManifest.agents[resolvedName]?.description ??
      null;
    const systemPromptLibraryRef =
      (manifestName ? normalizedManifest.agents[manifestName]?.systemPromptLibraryRef : null) ??
      normalizedManifest.agents[resolvedName]?.systemPromptLibraryRef ??
      null;

    if (agents.has(resolvedName)) {
      errors.push(
        `Imported agent name collision: "${resolvedName}" is declared by both "${agents.get(resolvedName)?.sourceFile}" and "${path}"`,
      );
      continue;
    }

    agents.set(resolvedName, {
      resolvedName,
      declaredName,
      manifestName,
      fileStem,
      sourceFile: path,
      dslContent: content,
      description,
      systemPromptLibraryRef,
      aliases,
    });

    if (manifestName && declaredName && manifestName !== declaredName) {
      warnings.push(
        `Resolved agent alias "${manifestName}" to declared agent "${declaredName}" from ${path}`,
      );
    }

    for (const alias of aliases) {
      const existing = aliasMap.get(alias);
      if (!existing) {
        aliasMap.set(alias, resolvedName);
        continue;
      }
      if (existing !== resolvedName) {
        aliasMap.delete(alias);
        ambiguousAliases.add(alias);
        warnings.push(
          `Imported agent alias "${alias}" is ambiguous between "${existing}" and "${resolvedName}"`,
        );
      }
    }
  }

  const requestedEntry = normalizedManifest.entryAgent;
  let entryAgent: ImportEntryAgentResolution = {
    requested: requestedEntry,
    resolved: null,
    matchedBy: requestedEntry ? 'missing' : 'none',
  };

  if (requestedEntry) {
    if (agents.has(requestedEntry)) {
      entryAgent = {
        requested: requestedEntry,
        resolved: requestedEntry,
        matchedBy: 'exact',
      };
    } else if (aliasMap.has(requestedEntry)) {
      entryAgent = {
        requested: requestedEntry,
        resolved: aliasMap.get(requestedEntry) ?? null,
        matchedBy: 'alias',
      };
      warnings.push(
        `Resolved entry agent alias "${requestedEntry}" to imported agent "${entryAgent.resolved}"`,
      );
    } else if (ambiguousAliases.has(requestedEntry)) {
      warnings.push(
        `Entry agent "${requestedEntry}" is ambiguous after import and will not be set automatically`,
      );
    } else {
      warnings.push(
        `Entry agent "${requestedEntry}" was not found in imported files and will not be set automatically`,
      );
    }
  }

  return {
    agents,
    aliasMap,
    ambiguousAliases,
    entryAgent,
    warnings,
    errors,
  };
}
