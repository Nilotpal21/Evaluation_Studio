/**
 * Module Tool Resolver
 *
 * Resolves imported module tool names (alias__toolname pattern) from module
 * release artifacts. Used as a fallback by resolveToolImplementations() when
 * a tool is not found in the consumer project's project_tools collection.
 *
 * The resolver:
 * 1. Looks up ProjectModuleDependency by alias for the consuming project
 * 2. Loads the resolved ModuleRelease artifact
 * 3. Extracts the tool's dslContent from the artifact
 * 4. Compiles it into a ToolDefinitionLocal via toToolDefinition (shared path)
 */

import {
  parseDslProperties,
  buildHttpBindingFromProps,
  buildSandboxBindingFromProps,
  buildMcpBindingFromProps,
} from './dsl-property-parser.js';
import {
  toToolDefinition,
  type ToolDefinitionLocal,
  type ResolvedToolImpl,
} from './resolve-tool-implementations.js';
import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('module-tool-resolver');

/**
 * Build a moduleToolResolver function scoped to a specific tenant + project.
 *
 * Returns a function matching the ResolveToolImplDeps.moduleToolResolver signature:
 *   (mountedName, alias, originalToolName) => Promise<ToolDefinitionLocal | null>
 *
 * Caches are scoped to the lifetime of the returned closure (one resolution pass).
 */
export function buildModuleToolResolver(
  tenantId: string,
  projectId: string,
): (
  mountedName: string,
  alias: string,
  originalToolName: string,
) => Promise<ToolDefinitionLocal | null> {
  // Cache loaded dependencies and releases within a single resolution pass
  // to avoid N+1 queries when multiple tools come from the same module.
  const depsByAlias = new Map<string, Record<string, unknown> | null>();
  const releaseCache = new Map<string, Record<string, unknown> | null>();

  return async (
    mountedName: string,
    alias: string,
    originalToolName: string,
  ): Promise<ToolDefinitionLocal | null> => {
    try {
      // 1. Resolve dependency by alias (cached per-alias)
      if (!depsByAlias.has(alias)) {
        const { ProjectModuleDependency } = await import('@agent-platform/database/models');
        const dep = await ProjectModuleDependency.findOne({
          tenantId,
          projectId,
          alias,
        }).lean();
        depsByAlias.set(alias, dep as Record<string, unknown> | null);
      }

      const dep = depsByAlias.get(alias);
      if (!dep) {
        return null;
      }

      const resolvedReleaseId = String(dep.resolvedReleaseId ?? '');
      const moduleProjectId = String(dep.moduleProjectId ?? '');
      if (!resolvedReleaseId || !moduleProjectId) {
        return null;
      }

      // 2. Load release artifact (cached per-releaseId, scoped by moduleProjectId)
      if (!releaseCache.has(resolvedReleaseId)) {
        const { ModuleRelease } = await import('@agent-platform/database/models');
        const release = await ModuleRelease.findOne({
          _id: resolvedReleaseId,
          tenantId,
          moduleProjectId,
        }).lean();
        releaseCache.set(resolvedReleaseId, release as Record<string, unknown> | null);
      }

      const release = releaseCache.get(resolvedReleaseId);
      if (!release) {
        return null;
      }

      // 3. Extract tool from artifact
      const artifact = release.artifact as Record<string, unknown> | undefined;
      if (!artifact) {
        return null;
      }

      const artifactTools = (artifact.tools ?? {}) as Record<string, Record<string, unknown>>;
      const toolData = artifactTools[originalToolName];
      if (!toolData) {
        return null;
      }

      const dslContent = String(toolData.dslContent ?? '');
      const toolType = String(toolData.toolType ?? '');
      const description = toolData.description ? String(toolData.description) : '';

      if (!dslContent || !toolType) {
        return null;
      }

      // 4. Build a ResolvedToolImpl and use the shared toToolDefinition path
      //    (includes full object-schema/items parameter parsing)
      return compileModuleToolToDefinition(mountedName, dslContent, toolType, description);
    } catch (err) {
      log.warn('Module tool resolution failed', {
        mountedName,
        alias,
        originalToolName,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
}

/**
 * Compile a module tool's DSL content into a ToolDefinitionLocal.
 * Builds a ResolvedToolImpl with the type-specific binding, then delegates
 * to toToolDefinition for parameter/hints/compaction parsing (shared path,
 * no duplication).
 */
function compileModuleToolToDefinition(
  mountedName: string,
  dslContent: string,
  toolType: string,
  description: string,
): ToolDefinitionLocal | null {
  try {
    const props = parseDslProperties(dslContent);

    // Build a minimal ResolvedToolImpl with binding
    const resolved: ResolvedToolImpl = {
      name: mountedName,
      toolType: toolType as ResolvedToolImpl['toolType'],
      projectToolId: `module:${mountedName}`,
      sourceHash: '',
      description: description || null,
      dslContent,
    };

    // Build type-specific binding — only http, sandbox, and mcp can be resolved
    // from module artifacts. searchai and workflow require project-scoped
    // validation and must fall through to E721.
    switch (toolType) {
      case 'http':
        resolved.httpBinding = buildHttpBindingFromProps(props, dslContent);
        break;
      case 'sandbox':
        resolved.sandboxBinding = buildSandboxBindingFromProps(props, dslContent);
        break;
      case 'mcp':
        resolved.mcpBinding = buildMcpBindingFromProps(props, mountedName, { dslContent });
        break;
      default:
        log.warn('Unsupported module tool type — cannot resolve from artifact', {
          mountedName,
          toolType,
        });
        return null;
    }

    // toToolDefinition handles full parameter parsing including object-schema,
    // items, return type, hints, and compaction — no duplication needed.
    return toToolDefinition(resolved);
  } catch (err) {
    log.warn('Module tool DSL compilation failed', {
      mountedName,
      toolType,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
