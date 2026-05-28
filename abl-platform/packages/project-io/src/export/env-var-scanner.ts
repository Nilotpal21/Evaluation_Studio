/**
 * Scan DSL content and extract referenced environment variable names.
 * Secret placeholders are tracked by their own scanners/contracts and must not
 * be advertised as environment variables during export provisioning.
 */

/** Extract all {{env.KEY}} references from DSL content */
export function extractEnvVarReferences(dslContent: string): string[] {
  const envPattern = /\{\{env\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
  const refs = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = envPattern.exec(dslContent)) !== null) {
    refs.add(match[1]);
  }
  return [...refs].sort();
}

/** Extract all {{secrets.KEY}} references from DSL content */
export function extractSecretReferences(dslContent: string): string[] {
  const secretPattern = /\{\{secrets\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
  const refs = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = secretPattern.exec(dslContent)) !== null) {
    refs.add(match[1]);
  }
  return [...refs].sort();
}

/** Extract all AUTH: references from DSL content */
const AUTH_TYPE_VALUES = new Set([
  'none',
  'api_key',
  'bearer',
  'oauth2_client',
  'oauth2_user',
  'custom',
  'searchai',
]);

const AUTH_TEMPLATE_RE = /^\{\{(?:config|env|secrets)\.[A-Za-z_][A-Za-z0-9_]*\}\}$/;
const CONNECTOR_RE = /^\s*CONNECTOR:\s+(\S+)/gm;
const MCP_SERVER_RE = /^\s*MCP_SERVER:\s+(\S+)/gm;

export function normalizeAuthProfileReference(rawReference: string): string | null {
  const trimmed = rawReference.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return null;

  const authProfileRefMatch = trimmed.match(/^auth_profile_ref\s+(.+)$/i);
  const candidate = (authProfileRefMatch?.[1] ?? trimmed).trim().replace(/^["']|["']$/g, '');
  if (!candidate) return null;

  if (AUTH_TEMPLATE_RE.test(candidate)) {
    return null;
  }

  if (AUTH_TYPE_VALUES.has(candidate.toLowerCase())) {
    return null;
  }

  return candidate;
}

export function extractAuthProfileReferences(dslContent: string): string[] {
  const refs = new Set<string>();
  const patterns = [/^\s*AUTH:\s+(.+)$/gim, /^\s*auth_profile(?:_ref)?\s*:\s*(.+)$/gim] as const;

  for (const pattern of patterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(dslContent)) !== null) {
      const normalized = normalizeAuthProfileReference(match[1]);
      if (normalized) {
        refs.add(normalized);
      }
    }
  }
  return [...refs].sort();
}

/** Extract CONNECTOR: references from tool DSL content. */
export function extractConnectorReferences(dslContent: string): string[] {
  const refs = new Set<string>();
  const re = new RegExp(CONNECTOR_RE.source, CONNECTOR_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(dslContent)) !== null) {
    refs.add(match[1]);
  }
  return [...refs].sort();
}

/** Extract MCP_SERVER: references from tool DSL content. */
export function extractMcpServerReferences(dslContent: string): string[] {
  const refs = new Set<string>();
  const re = new RegExp(MCP_SERVER_RE.source, MCP_SERVER_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(dslContent)) !== null) {
    refs.add(match[1]);
  }
  return [...refs].sort();
}

/**
 * Scan all agent and tool DSL content, returning deduplicated env var names.
 */
export function scanProjectEnvVars(
  agents: Array<{ dslContent: string }>,
  tools: Array<{ content?: string; dslContent?: string }>,
): string[] {
  const allRefs = new Set<string>();

  for (const agent of agents) {
    if (!agent.dslContent) continue;
    for (const ref of extractEnvVarReferences(agent.dslContent)) allRefs.add(ref);
  }

  for (const tool of tools) {
    const content = tool.content ?? tool.dslContent ?? '';
    if (!content) continue;
    for (const ref of extractEnvVarReferences(content)) allRefs.add(ref);
  }

  return [...allRefs].sort();
}

/**
 * Scan all agent and tool DSL content for AUTH: references.
 * Returns deduplicated auth profile names.
 */
export function scanProjectAuthProfiles(
  agents: Array<{ dslContent: string }>,
  tools: Array<{ content?: string; dslContent?: string }>,
): string[] {
  const allRefs = new Set<string>();

  for (const agent of agents) {
    if (!agent.dslContent) continue;
    for (const ref of extractAuthProfileReferences(agent.dslContent)) allRefs.add(ref);
  }

  for (const tool of tools) {
    const content = tool.content ?? tool.dslContent ?? '';
    if (!content) continue;
    for (const ref of extractAuthProfileReferences(content)) allRefs.add(ref);
  }

  return [...allRefs].sort();
}

export interface ProjectAuthProfileRequirement {
  name: string;
  authType: string;
  scope: 'tenant' | 'project';
  connector?: string;
  category?: string;
  connectionMode?: 'shared' | 'per_user';
  config: Record<string, unknown>;
  referencedBy: string[];
}

function addAuthProfileReference(
  refs: Map<string, Set<string>>,
  profileName: string,
  referencedBy: string,
): void {
  const existing = refs.get(profileName) ?? new Set<string>();
  existing.add(referencedBy);
  refs.set(profileName, existing);
}

export function scanProjectAuthProfileRequirements(
  agents: Array<{ name?: string; dslContent: string }>,
  tools: Array<{ name?: string; content?: string; dslContent?: string }>,
): ProjectAuthProfileRequirement[] {
  const refs = new Map<string, Set<string>>();

  for (const agent of agents) {
    if (!agent.dslContent) continue;
    const referencedBy = agent.name ?? 'agent';
    for (const ref of extractAuthProfileReferences(agent.dslContent)) {
      addAuthProfileReference(refs, ref, referencedBy);
    }
  }

  for (const tool of tools) {
    const content = tool.content ?? tool.dslContent ?? '';
    if (!content) continue;
    const referencedBy = `tool:${tool.name ?? extractToolName(content) ?? 'tool'}`;
    for (const ref of extractAuthProfileReferences(content)) {
      addAuthProfileReference(refs, ref, referencedBy);
    }
  }

  return [...refs.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, referencedBy]) => ({
      name,
      authType: 'unknown',
      scope: 'project' as const,
      config: {},
      referencedBy: [...referencedBy].sort(),
    }));
}

export function scanProjectConnectorReferences(
  tools: Array<{ content?: string; dslContent?: string }>,
): string[] {
  const refs = new Set<string>();
  for (const tool of tools) {
    const content = tool.content ?? tool.dslContent ?? '';
    if (!content) continue;
    for (const ref of extractConnectorReferences(content)) refs.add(ref);
  }
  return [...refs].sort();
}

export function scanProjectMcpServerReferences(
  tools: Array<{ content?: string; dslContent?: string }>,
): string[] {
  const refs = new Set<string>();
  for (const tool of tools) {
    const content = tool.content ?? tool.dslContent ?? '';
    if (!content) continue;
    for (const ref of extractMcpServerReferences(content)) refs.add(ref);
  }
  return [...refs].sort();
}

function extractToolName(content: string): string | null {
  const match = content.match(/^\s*TOOL:\s*(\S+)/m);
  return match?.[1] ?? null;
}
