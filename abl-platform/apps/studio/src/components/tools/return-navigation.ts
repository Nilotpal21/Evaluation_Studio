const RETURN_TO_PARAM = 'returnTo';

export function buildAgentToolsReturnPath(projectId: string, agentName: string): string {
  return `/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentName)}#tools`;
}

export function appendReturnTo(path: string, returnTo: string | null): string {
  if (!returnTo) {
    return path;
  }

  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${RETURN_TO_PARAM}=${encodeURIComponent(returnTo)}`;
}

export function getProjectScopedReturnTo(projectId: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return resolveProjectScopedReturnTo(window.location.search, projectId, window.location.origin);
}

export function resolveProjectScopedReturnTo(
  search: string,
  projectId: string,
  origin: string,
): string | null {
  const rawReturnTo = new URLSearchParams(search).get(RETURN_TO_PARAM);
  if (!rawReturnTo) {
    return null;
  }

  let returnUrl: URL;
  try {
    returnUrl = new URL(rawReturnTo, origin);
  } catch {
    return null;
  }

  if (returnUrl.origin !== origin) {
    return null;
  }

  const projectPath = `/projects/${encodeURIComponent(projectId)}`;
  if (returnUrl.pathname !== projectPath && !returnUrl.pathname.startsWith(`${projectPath}/`)) {
    return null;
  }

  return `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`;
}
