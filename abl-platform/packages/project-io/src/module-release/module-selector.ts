/**
 * Module Selector
 *
 * Resolves a version or environment selector to a concrete ModuleRelease.
 * Version selectors find a release by exact version string.
 * Environment selectors resolve the current pointer for that environment,
 * then load the pointed-to release.
 */

import { ModuleRelease, ModuleEnvironmentPointer } from '@agent-platform/database/models';

export type ModuleSelector = { type: 'version' | 'environment'; value: string };

export type ModuleSelectorSuccess = { releaseId: string; version: string };
export type ModuleSelectorError = { error: string };
export type ModuleSelectorResult = ModuleSelectorSuccess | ModuleSelectorError;

/**
 * Resolve a module selector to a concrete release.
 *
 * @param tenantId - Tenant scope for all queries
 * @param moduleProjectId - The module project to resolve against
 * @param selector - Version or environment selector
 * @returns The resolved release ID and version, or an error message
 */
export async function resolveSelector(
  tenantId: string,
  moduleProjectId: string,
  selector: ModuleSelector,
): Promise<ModuleSelectorResult> {
  if (selector.type === 'version') {
    const release = await ModuleRelease.findOne({
      tenantId,
      moduleProjectId,
      version: selector.value,
      archivedAt: null,
    });
    if (!release) return { error: `Version ${selector.value} not found or archived` };
    return { releaseId: release._id, version: release.version };
  }

  if (selector.type === 'environment') {
    const pointer = await ModuleEnvironmentPointer.findOne({
      tenantId,
      moduleProjectId,
      environment: selector.value,
    });
    if (!pointer) {
      return {
        error: `No release promoted to '${selector.value}' environment. Promote a release first.`,
      };
    }
    const release = await ModuleRelease.findOne({
      _id: pointer.moduleReleaseId,
      tenantId,
      moduleProjectId,
      archivedAt: null,
    });
    if (!release) return { error: `Promoted release has been archived` };
    return { releaseId: release._id, version: release.version };
  }

  return { error: `Unknown selector type: ${(selector as ModuleSelector).type}` };
}
