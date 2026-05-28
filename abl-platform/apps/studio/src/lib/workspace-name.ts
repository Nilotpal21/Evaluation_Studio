const DEFAULT_WORKSPACE_OWNER_NAME = 'My';
const DEFAULT_WORKSPACE_SUFFIX = 'Workspace';
const MAX_WORKSPACE_NAME_LENGTH = 100;

const COMBINING_MARK_PATTERN = /[\u0300-\u036f]/g;
const UNSUPPORTED_WORKSPACE_NAME_CHARACTER_PATTERN = /[^a-zA-Z0-9\s\-_.]+/g;
const WORKSPACE_NAME_EDGE_SEPARATOR_PATTERN = /^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g;
const WHITESPACE_PATTERN = /\s+/g;

function sanitizeWorkspaceNameSegment(value: string): string {
  return value
    .normalize('NFKD')
    .replace(COMBINING_MARK_PATTERN, '')
    .replace(UNSUPPORTED_WORKSPACE_NAME_CHARACTER_PATTERN, ' ')
    .replace(WHITESPACE_PATTERN, ' ')
    .replace(WORKSPACE_NAME_EDGE_SEPARATOR_PATTERN, '')
    .trim();
}

export function buildDefaultWorkspaceName(userName?: string): string {
  const maxOwnerLength = MAX_WORKSPACE_NAME_LENGTH - DEFAULT_WORKSPACE_SUFFIX.length - 1;
  const sanitizedOwnerName =
    sanitizeWorkspaceNameSegment(userName ?? '').slice(0, maxOwnerLength) ||
    DEFAULT_WORKSPACE_OWNER_NAME;
  const trimmedOwnerName =
    sanitizeWorkspaceNameSegment(sanitizedOwnerName) || DEFAULT_WORKSPACE_OWNER_NAME;

  return `${trimmedOwnerName} ${DEFAULT_WORKSPACE_SUFFIX}`;
}
