import type { Metadata } from 'next';
import { getFeatureDocs, getTestDocs } from '../../../../lib/docs/source-docs';

export const metadata: Metadata = {
  title: 'Feature & Test Status — Internal Docs',
  description: 'All platform features and test specs with live status from source-of-truth docs.',
};

const STATUS_ORDER: Record<string, number> = {
  STABLE: 0,
  BETA: 1,
  ALPHA: 2,
  PLANNED: 3,
  UNKNOWN: 4,
};

function badge(status: string) {
  const colors: Record<string, string> = {
    STABLE: 'bg-emerald-500/15 text-emerald-400',
    BETA: 'bg-blue-500/15 text-blue-400',
    ALPHA: 'bg-amber-500/15 text-amber-400',
    PLANNED: 'bg-zinc-500/15 text-zinc-400',
    UNKNOWN: 'bg-red-500/15 text-red-400',
  };
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${colors[status] || colors.UNKNOWN}`}
    >
      {status}
    </span>
  );
}

export default async function FeaturesPage() {
  const [features, tests] = await Promise.all([getFeatureDocs(), getTestDocs()]);

  // Build test lookup by slug
  const testBySlug = new Map(tests.map((t) => [t.featureSlug, t]));

  // Sort features by status then name
  const sorted = [...features].sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 4;
    const sb = STATUS_ORDER[b.status] ?? 4;
    if (sa !== sb) return sa - sb;
    return a.title.localeCompare(b.title);
  });

  const counts = {
    total: features.length,
    stable: features.filter((f) => f.status === 'STABLE').length,
    beta: features.filter((f) => f.status === 'BETA').length,
    alpha: features.filter((f) => f.status === 'ALPHA').length,
    planned: features.filter((f) => f.status === 'PLANNED').length,
  };

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-2 text-3xl font-bold text-foreground">Feature & Test Status</h1>
      <p className="mb-6 text-muted">
        Auto-generated from <code>docs/features/</code> and <code>docs/testing/</code> — the source
        of truth.
      </p>

      <div className="mb-8 flex gap-3 text-sm">
        <span className="rounded bg-background-muted px-2 py-1">{counts.total} features</span>
        <span className="rounded bg-emerald-500/15 px-2 py-1 text-emerald-400">
          {counts.stable} stable
        </span>
        <span className="rounded bg-blue-500/15 px-2 py-1 text-blue-400">{counts.beta} beta</span>
        <span className="rounded bg-amber-500/15 px-2 py-1 text-amber-400">
          {counts.alpha} alpha
        </span>
        <span className="rounded bg-zinc-500/15 px-2 py-1 text-zinc-400">
          {counts.planned} planned
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-default">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-default bg-background-muted text-xs uppercase text-muted">
              <th className="px-3 py-2">Feature</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Test Spec</th>
              <th className="px-3 py-2 text-center">E2E</th>
              <th className="px-3 py-2 text-center">INT</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((f) => {
              const test = testBySlug.get(f.slug);
              return (
                <tr
                  key={f.slug}
                  className="border-b border-default last:border-0 transition-colors hover:bg-background-muted/50"
                >
                  <td className="px-3 py-2 font-medium">
                    <a
                      href={`/docs/features/${f.slug}`}
                      className="text-foreground hover:text-accent"
                    >
                      {f.title}
                    </a>
                  </td>
                  <td className="px-3 py-2">{badge(f.status)}</td>
                  <td className="px-3 py-2 text-muted">
                    {test ? (
                      <a
                        href={`/docs/testing/${test.featureSlug}`}
                        className="text-emerald-400 hover:underline"
                      >
                        Yes
                      </a>
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center text-muted">
                    {test && test.e2eCount > 0 ? test.e2eCount : '—'}
                  </td>
                  <td className="px-3 py-2 text-center text-muted">
                    {test && test.intCount > 0 ? test.intCount : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
