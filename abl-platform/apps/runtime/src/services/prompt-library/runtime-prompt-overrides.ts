import { createLogger } from '@abl/compiler/platform';
import { getPromptLibraryService } from './prompt-library-service.js';
import { renderPromptTemplate } from './template-renderer.js';

const log = createLogger('runtime-prompt-overrides');

export interface RuntimePromptOverrideRef {
  promptId: string;
  versionId: string;
}

export interface RuntimePromptOverrideScope {
  tenantId?: string;
  projectId?: string;
}

export async function resolveRuntimePromptOverride(
  ref: RuntimePromptOverrideRef | undefined,
  scope: RuntimePromptOverrideScope,
  variables: Record<string, unknown>,
): Promise<string | null> {
  if (!ref || !scope.tenantId || !scope.projectId) {
    return null;
  }

  try {
    const version = await getPromptLibraryService().getVersion(ref.promptId, ref.versionId, {
      tenantId: scope.tenantId,
      projectId: scope.projectId,
    });
    if (!version) {
      log.warn('Runtime prompt override version not found', {
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        promptId: ref.promptId,
        versionId: ref.versionId,
      });
      return null;
    }

    if (version.status === 'archived') {
      log.warn('Runtime prompt override version is archived', {
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        promptId: ref.promptId,
        versionId: ref.versionId,
      });
      return null;
    }

    return renderPromptTemplate(version.template, variables);
  } catch (err) {
    log.warn('Runtime prompt override resolution failed', {
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      promptId: ref.promptId,
      versionId: ref.versionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
