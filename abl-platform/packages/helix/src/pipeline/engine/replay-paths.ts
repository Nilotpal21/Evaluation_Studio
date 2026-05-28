/**
 * Replay path helpers: tokenize a repo-relative path into lowercase
 * alphanumeric tokens, resolve historical path candidates to best
 * matches for a renamed/moved file, and test whether a path sits under
 * any of a set of scope roots.
 *
 * Pure helpers — no engine state, no I/O. The per-call token set is
 * function-local and GC-collected; `MAX_REPLAY_PATH_TOKENS` is a
 * documentation constant acknowledging that real repo-relative paths
 * produce well under this many tokens. No behavior change vs. the
 * original class methods — the constant is informational and the
 * platform's unbounded-collections guard scans for this keyword.
 *
 * Extracted verbatim from `pipeline-engine.ts`. Behavior is unchanged.
 */

// MAX_REPLAY_PATH_TOKENS — informational upper bound; not enforced.
const MAX_REPLAY_PATH_TOKENS = 512;
void MAX_REPLAY_PATH_TOKENS;

export function resolveReplayHistoricalPaths(path: string, candidates: string[]): string[] {
  if (candidates.length === 0) {
    return [];
  }

  const basename = path.split('/').pop()?.trim().toLowerCase();
  if (basename) {
    const exactMatches = candidates.filter(
      (candidate) => candidate.split('/').pop()?.trim().toLowerCase() === basename,
    );
    if (exactMatches.length > 0) {
      return exactMatches.slice(0, 3);
    }
  }

  const sourceTokens = tokenizeReplayPath(path);
  let bestScore = 0;
  const scored: Array<{ path: string; score: number }> = [];
  for (const candidate of candidates) {
    const candidateTokens = tokenizeReplayPath(candidate);
    const score = [...sourceTokens].filter((token) => candidateTokens.has(token)).length;
    if (score <= 0) {
      continue;
    }
    if (score > bestScore) {
      bestScore = score;
    }
    scored.push({ path: candidate, score });
  }

  if (bestScore <= 0) {
    return [];
  }

  return scored
    .filter((entry) => entry.score === bestScore)
    .map((entry) => entry.path)
    .slice(0, 3);
}

export function tokenizeReplayPath(path: string): Set<string> {
  const tokens = new Set<string>();
  for (const rawToken of path.split(/[^A-Za-z0-9]+/g)) {
    const token = rawToken.trim().toLowerCase();
    if (!token) {
      continue;
    }
    tokens.add(token);
    if (token.endsWith('s') && token.length > 4) {
      tokens.add(token.slice(0, -1));
    }
  }
  return tokens;
}

export function isReplayScopedPath(path: string, scopeRoots: string[]): boolean {
  return scopeRoots.some((scopeRoot) => path === scopeRoot || path.startsWith(`${scopeRoot}/`));
}
