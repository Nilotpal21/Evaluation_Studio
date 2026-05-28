import {
  PromptLibraryVersion,
  computeSourceHash,
  type IPromptLibraryVersion,
} from '@agent-platform/database/models';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';

export interface InjectedPromptLibraryRef {
  promptId: string;
  versionId: string;
  resolvedHash?: string;
}

export interface PromptLibraryRefScope {
  tenantId: string;
  projectId: string;
}

export interface PromptLibraryRefDocument {
  systemPrompt?: string | null;
  systemPromptLibraryRef?: InjectedPromptLibraryRef | null;
}

export async function resolvePromptLibraryRefVersion(
  ref: InjectedPromptLibraryRef,
  scope: PromptLibraryRefScope,
): Promise<IPromptLibraryVersion> {
  const version = (await PromptLibraryVersion.findOne({
    _id: ref.versionId,
    promptId: ref.promptId,
    tenantId: scope.tenantId,
    projectId: scope.projectId,
  }).lean()) as IPromptLibraryVersion | null;

  if (!version || version.status === 'archived') {
    throw new AppError('Referenced prompt library version is not available for compilation', {
      ...ErrorCodes.BAD_REQUEST,
      code: 'PROMPT_LIBRARY_VERSION_NOT_FOUND',
    });
  }

  return version;
}

export async function resolvePromptLibraryRefOnDocument(
  document: PromptLibraryRefDocument,
  scope: PromptLibraryRefScope,
): Promise<void> {
  const ref = document.systemPromptLibraryRef;
  if (!ref) {
    return;
  }

  const version = await resolvePromptLibraryRefVersion(ref, scope);
  document.systemPrompt = version.template;
  ref.resolvedHash = computeSourceHash(version.template, version.variables);
}
