import type { ArchSession } from './types';

export type SessionSurface = 'project' | 'agent-editor';
export type InProjectSessionScope = {
  mode: 'IN_PROJECT';
  projectId: string;
  surface?: SessionSurface;
  agentName?: string;
  threadId?: string;
};
export type SessionScope = { mode: 'ONBOARDING'; threadId?: string } | InProjectSessionScope;

function normalizeProjectId(projectId: unknown): string | null {
  if (typeof projectId !== 'string') {
    return null;
  }

  const trimmed = projectId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeThreadId(threadId: unknown): string | undefined {
  if (typeof threadId !== 'string') {
    return undefined;
  }

  const trimmed = threadId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function deriveSessionScope(session: ArchSession | null | undefined): SessionScope | null {
  const threadId = normalizeThreadId(session?.metadata.threadId);

  if (session?.metadata.mode === 'IN_PROJECT') {
    const projectId = normalizeProjectId(session.metadata.projectId);
    if (!projectId) {
      return null;
    }
    const surface = session.metadata.surface;
    const agentName =
      typeof session.metadata.agentName === 'string' && session.metadata.agentName.trim().length > 0
        ? session.metadata.agentName.trim()
        : undefined;
    return {
      mode: 'IN_PROJECT',
      projectId,
      ...(threadId ? { threadId } : {}),
      ...(surface === 'agent-editor' ? { surface: 'agent-editor' as const, agentName } : {}),
    };
  }

  return { mode: 'ONBOARDING', ...(threadId ? { threadId } : {}) };
}

export function resolveSessionScope(
  session: ArchSession | null | undefined,
  mode?: 'ONBOARDING' | 'IN_PROJECT',
  projectId?: string,
  options?: { surface?: SessionSurface; agentName?: string; threadId?: string },
): SessionScope | null {
  const threadId = normalizeThreadId(options?.threadId);

  if (mode === 'ONBOARDING') {
    return { mode: 'ONBOARDING', ...(threadId ? { threadId } : {}) };
  }

  if (mode === 'IN_PROJECT') {
    const normalizedProjectId = normalizeProjectId(projectId);
    if (normalizedProjectId) {
      return {
        mode: 'IN_PROJECT',
        projectId: normalizedProjectId,
        ...(threadId ? { threadId } : {}),
        ...(options?.surface === 'agent-editor'
          ? { surface: 'agent-editor' as const, agentName: options.agentName }
          : {}),
      };
    }

    const derivedScope = deriveSessionScope(session);
    return derivedScope?.mode === 'IN_PROJECT' ? derivedScope : null;
  }

  return deriveSessionScope(session);
}
