/**
 * Path Normalizer — strips common wrapper prefixes from zip entries
 *
 * ZIP files from GitHub downloads wrap contents in a root directory like
 * `repo-branch/`. This normalizer strips the wrapper so folder-reader
 * sees the canonical structure it expects.
 */

const CONTENT_DIR_NAMES = new Set([
  'agents',
  'tools',
  'config',
  'core',
  'deployments',
  'locales',
  'behavior_profiles',
  'connections',
  'prompts',
  'guardrails',
  'workflows',
  'evals',
  'search',
  'channels',
  'vocabulary',
  'environment',
]);
const CONTENT_MARKERS = ['project.json', 'abl.lock'];
const CONTENT_PATTERNS = [
  /\.agent\.abl$/,
  /\.agent\.yaml$/,
  /\.tools\.abl$/,
  /\.behavior_profile\.abl$/,
  /\.profile\.abl$/,
];

function looksLikeAgentDsl(content: string): boolean {
  return /^\s*(?:AGENT|SUPERVISOR|agent|supervisor)\s*:/m.test(content);
}

function looksLikeToolDsl(content: string): boolean {
  return /^\s*TOOLS?\s*:/m.test(content) || /^\s*\w+\s*\(/m.test(content);
}

function remapManifestPaths(
  manifestContent: string,
  normalizedPathMap: Map<string, string>,
): string | null {
  try {
    const parsed = JSON.parse(manifestContent) as Record<string, unknown>;
    let changed = false;

    const rewriteRecords = (records: unknown) => {
      if (!records || typeof records !== 'object' || Array.isArray(records)) {
        return;
      }

      for (const record of Object.values(records as Record<string, unknown>)) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          continue;
        }

        const currentPath = (record as { path?: unknown }).path;
        if (typeof currentPath !== 'string') {
          continue;
        }

        const rewrittenPath = normalizedPathMap.get(currentPath);
        if (rewrittenPath && rewrittenPath !== currentPath) {
          (record as { path: string }).path = rewrittenPath;
          changed = true;
        }
      }
    };

    rewriteRecords(parsed.agents);
    rewriteRecords(parsed.tools);
    rewriteRecords(parsed.behavior_profiles);

    return changed ? JSON.stringify(parsed, null, 2) : null;
  } catch {
    return null;
  }
}

function normalizeLooseImportPaths(files: Map<string, string>): Map<string, string> {
  const normalized = new Map<string, string>();
  const normalizedPathMap = new Map<string, string>();

  for (const [path, content] of files) {
    if (path === 'project.json' || path === 'abl.lock') {
      normalized.set(path, content);
      continue;
    }

    const segments = path.split('/');
    const fileName = segments.at(-1) ?? path;
    const parentDir = segments.length > 1 ? segments.slice(0, -1).join('/') : '';

    let normalizedPath = path;

    if (!parentDir && (fileName.endsWith('.agent.abl') || fileName.endsWith('.agent.yaml'))) {
      normalizedPath = `agents/${fileName}`;
    } else if (!parentDir && fileName.endsWith('.tools.abl')) {
      normalizedPath = `tools/${fileName}`;
    } else if (
      !parentDir &&
      (fileName.endsWith('.behavior_profile.abl') || fileName.endsWith('.profile.abl'))
    ) {
      normalizedPath = `behavior_profiles/${fileName}`;
    } else if (
      (parentDir === '' || parentDir === 'agents' || parentDir.startsWith('agents/')) &&
      fileName.endsWith('.abl') &&
      !fileName.endsWith('.agent.abl') &&
      looksLikeAgentDsl(content)
    ) {
      const targetDir = parentDir || 'agents';
      normalizedPath = `${targetDir}/${fileName.replace(/\.abl$/, '.agent.abl')}`;
    } else if (
      (parentDir === '' || parentDir === 'tools' || parentDir.startsWith('tools/')) &&
      fileName.endsWith('.abl') &&
      !fileName.endsWith('.tools.abl') &&
      looksLikeToolDsl(content)
    ) {
      const targetDir = parentDir || 'tools';
      normalizedPath = `${targetDir}/${fileName.replace(/\.abl$/, '.tools.abl')}`;
    }

    normalized.set(normalizedPath, content);
    if (normalizedPath !== path) {
      normalizedPathMap.set(path, normalizedPath);
    }
  }

  if (normalizedPathMap.size === 0) {
    return normalized;
  }

  const manifestContent = normalized.get('project.json');
  if (manifestContent) {
    const rewrittenManifest = remapManifestPaths(manifestContent, normalizedPathMap);
    if (rewrittenManifest) {
      normalized.set('project.json', rewrittenManifest);
    }
  }

  return normalized;
}

function isContentFile(segment: string): boolean {
  if (CONTENT_MARKERS.includes(segment)) return true;
  return CONTENT_PATTERNS.some((p) => p.test(segment));
}

/**
 * Strip the longest common directory prefix from a set of file paths,
 * stopping before content markers (project.json, *.agent.abl, etc.).
 */
export function stripCommonPrefix(files: Map<string, string>): {
  files: Map<string, string>;
  strippedPrefix: string | null;
} {
  const paths = Array.from(files.keys());
  if (paths.length === 0) return { files, strippedPrefix: null };

  // Split all paths into segments
  const segmentArrays = paths.map((p) => p.split('/'));

  // Find minimum depth
  const minDepth = Math.min(...segmentArrays.map((s) => s.length));

  // Find longest common prefix of segments, stopping before content markers
  let commonPrefixLength = 0;
  for (let i = 0; i < minDepth - 1; i++) {
    const segment = segmentArrays[0][i];

    // Stop if this segment is a content marker or a known content directory
    if (isContentFile(segment) || CONTENT_DIR_NAMES.has(segment)) break;

    // Check all paths share this segment
    const allMatch = segmentArrays.every((segs) => segs[i] === segment);
    if (!allMatch) break;

    commonPrefixLength = i + 1;
  }

  if (commonPrefixLength === 0) {
    return { files: normalizeLooseImportPaths(files), strippedPrefix: null };
  }

  const prefix = segmentArrays[0].slice(0, commonPrefixLength).join('/') + '/';
  const stripped = new Map<string, string>();
  for (const [path, content] of files) {
    stripped.set(path.slice(prefix.length), content);
  }

  return { files: normalizeLooseImportPaths(stripped), strippedPrefix: prefix };
}
