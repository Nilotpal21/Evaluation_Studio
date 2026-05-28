export interface AgentPromptLibraryRefSnapshot {
  promptId: string;
  versionId: string;
  resolvedHash?: string;
}

export interface AgentCompanionMetadata {
  systemPromptLibraryRef?: AgentPromptLibraryRefSnapshot | null;
  resolvedSystemPrompt?: string | null;
}

function normalizePromptLibraryRefSnapshot(ref: unknown): AgentPromptLibraryRefSnapshot | null {
  if (!ref || typeof ref !== 'object') {
    return null;
  }

  const promptId = 'promptId' in ref ? ref.promptId : undefined;
  const versionId = 'versionId' in ref ? ref.versionId : undefined;
  const resolvedHash = 'resolvedHash' in ref ? ref.resolvedHash : undefined;

  if (typeof promptId !== 'string' || typeof versionId !== 'string') {
    return null;
  }

  return {
    promptId,
    versionId,
    ...(typeof resolvedHash === 'string' ? { resolvedHash } : {}),
  };
}

export function normalizeAgentCompanionMetadata(value: unknown): AgentCompanionMetadata | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const systemPromptLibraryRef = normalizePromptLibraryRefSnapshot(
    'systemPromptLibraryRef' in value ? value.systemPromptLibraryRef : null,
  );
  const resolvedSystemPrompt =
    'resolvedSystemPrompt' in value && typeof value.resolvedSystemPrompt === 'string'
      ? value.resolvedSystemPrompt
      : null;

  if (!systemPromptLibraryRef && !resolvedSystemPrompt) {
    return null;
  }

  return {
    ...(systemPromptLibraryRef ? { systemPromptLibraryRef } : {}),
    ...(resolvedSystemPrompt ? { resolvedSystemPrompt } : {}),
  };
}

export function buildAgentCompanionHashInput(value: unknown): Record<string, unknown> | null {
  const normalized = normalizeAgentCompanionMetadata(value);
  if (!normalized) {
    return null;
  }

  return {
    systemPromptLibraryRef: normalized.systemPromptLibraryRef ?? null,
    resolvedSystemPrompt: normalized.resolvedSystemPrompt ?? null,
  };
}

export function buildAgentManifestCompanion(value: unknown): Record<string, unknown> | null {
  const normalized = normalizeAgentCompanionMetadata(value);
  if (!normalized?.systemPromptLibraryRef) {
    return null;
  }

  return {
    systemPromptLibraryRef: normalized.systemPromptLibraryRef,
  };
}

interface CompiledAgentLike {
  identity?: {
    system_prompt?: {
      libraryRef?: {
        promptId: string;
        versionId: string;
        resolvedHash: string;
      };
    } | null;
  } | null;
}

export function attachAgentCompanionLibraryRefs(
  compiledAgents: Record<string, CompiledAgentLike>,
  companions: Record<string, AgentCompanionMetadata | null | undefined>,
): void {
  for (const [agentName, companionValue] of Object.entries(companions)) {
    const companion = normalizeAgentCompanionMetadata(companionValue);
    if (
      !companion?.systemPromptLibraryRef ||
      typeof companion.systemPromptLibraryRef.resolvedHash !== 'string'
    ) {
      continue;
    }

    const identity = compiledAgents[agentName]?.identity;
    if (!identity || typeof identity !== 'object') {
      continue;
    }

    const systemPromptSection = identity.system_prompt;
    if (!systemPromptSection || typeof systemPromptSection !== 'object') {
      continue;
    }

    systemPromptSection.libraryRef = {
      promptId: companion.systemPromptLibraryRef.promptId,
      versionId: companion.systemPromptLibraryRef.versionId,
      resolvedHash: companion.systemPromptLibraryRef.resolvedHash,
    };
  }
}
