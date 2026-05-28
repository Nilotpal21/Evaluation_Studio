/**
 * Semver descending comparator — canonical implementation used by runtime,
 * workflow-engine, and (via re-export) Studio.
 *
 * Zero-dependency: a hand-rolled parser accepts `vX.Y.Z` and `X.Y.Z` with an
 * optional `-prerelease` suffix. Rejects anything outside that shape, which
 * matches the shape the workflow-version service actually emits (`nextVersion`
 * only produces `vMAJ.MIN.PAT`).
 *
 * Ordering (high → low):
 *   valid semver (e.g. v1.2.0 > v0.10.0 > v0.10.0-rc.1) → invalid strings → 'draft'
 *
 * Invalid non-draft strings sort AFTER valid semvers but BEFORE 'draft', so a
 * single bad record in the DB cannot throw or demote valid versions below the
 * draft.
 */

interface ParsedSemver {
  core: [number, number, number];
  prerelease: Array<number | string>;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?$/;

function parseSemver(v: string): ParsedSemver | null {
  const m = SEMVER_RE.exec(v);
  if (!m) return null;
  const [, maj, min, pat, pre] = m;
  const prerelease: Array<number | string> = pre
    ? pre.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))
    : [];
  return {
    core: [Number(maj), Number(min), Number(pat)],
    prerelease,
  };
}

/** Pre-release identifier comparison per semver spec §11 item 4. */
function comparePrerelease(a: Array<number | string>, b: Array<number | string>): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const [ai, bi] = [a[i], b[i]];
    const aNum = typeof ai === 'number';
    const bNum = typeof bi === 'number';
    if (aNum && bNum) {
      if (ai !== bi) return (ai as number) - (bi as number);
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (ai !== bi) {
      return (ai as string) < (bi as string) ? -1 : 1;
    }
  }
  return a.length - b.length;
}

export function compareSemverDesc(a: string, b: string): number {
  if (a === 'draft' && b === 'draft') return 0;
  if (a === 'draft') return 1;
  if (b === 'draft') return -1;
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa && pb) {
    for (let i = 0; i < 3; i++) {
      if (pa.core[i] !== pb.core[i]) return pb.core[i] - pa.core[i];
    }
    // Coerce -0 → 0 so callers using Object.is-based equality assertions work.
    return -comparePrerelease(pa.prerelease, pb.prerelease) || 0;
  }
  if (pa && !pb) return -1;
  if (!pa && pb) return 1;
  return 0;
}
