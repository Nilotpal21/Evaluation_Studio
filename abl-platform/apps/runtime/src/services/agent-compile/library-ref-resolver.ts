/**
 * Library Ref Resolver
 *
 * Pre-compile hook: resolves a stored prompt library reference into the
 * agent document's systemPrompt field before compileABLtoIR() runs.
 *
 * Called by VersionService.createVersion() when the agent has
 * IProjectAgent.systemPromptLibraryRef set.
 */

import type { AgentBasedDocument } from '@abl/core';
import {
  resolvePromptLibraryRefOnDocument,
  type InjectedPromptLibraryRef,
} from '@agent-platform/shared/prompts';

export type InjectedLibraryRef = InjectedPromptLibraryRef;

/**
 * Resolve a prompt library reference into the agent document.
 *
 * Expects `(document as any).systemPromptLibraryRef` to be set by the caller
 * (VersionService.createVersion) before this function is invoked.
 *
 * On success:
 *   - `document.systemPrompt` is replaced with the version's template
 *   - `(document as any).systemPromptLibraryRef.resolvedHash` is set
 *
 * On failure (version not found, status archived):
 *   - throws AppError 400 PROMPT_LIBRARY_VERSION_NOT_FOUND
 */
export async function resolveLibraryRef(
  document: AgentBasedDocument,
  tenantId: string,
  projectId: string,
): Promise<void> {
  await resolvePromptLibraryRefOnDocument(
    document as unknown as {
      systemPrompt?: string | null;
      systemPromptLibraryRef?: InjectedLibraryRef | null;
    },
    {
      tenantId,
      projectId,
    },
  );
}
