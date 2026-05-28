import type { Metadata } from 'next';
import { getTestDocs, getFeatureDocs } from '../../../../lib/docs/source-docs';

export const metadata: Metadata = {
  title: 'Test Coverage — Internal Docs',
  description: 'Test spec status and scenario counts from docs/testing/.',
};

export default async function TestingPage() {
  const [tests, features] = await Promise.all([getTestDocs(), getFeatureDocs()]);

  const featureBySlug = new Map(features.map((f) => [f.slug, f]));

  const sorted = [...tests].sort((a, b) => a.title.localeCompare(b.title));

  const withE2E = tests.filter((t) => t.e2eCount > 0);
  const withInt = tests.filter((t) => t.intCount > 0);
  const totalE2E = tests.reduce((sum, t) => sum + t.e2eCount, 0);
  const totalInt = tests.reduce((sum, t) => sum + t.intCount, 0);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-2 text-3xl font-bold text-foreground">Test Coverage</h1>
      <p className="mb-6 text-muted">
        Auto-generated from <code>docs/testing/</code> — the source of truth.
      </p>

      <div className="mb-8 flex gap-3 text-sm">
        <span className="rounded bg-background-muted px-2 py-1">{tests.length} test specs</span>
        <span className="rounded bg-emerald-500/15 px-2 py-1 text-emerald-400">
          {totalE2E} E2E scenarios
        </span>
        <span className="rounded bg-blue-500/15 px-2 py-1 text-blue-400">
          {totalInt} integration scenarios
        </span>
        <span className="rounded bg-background-muted px-2 py-1">
          {withE2E.length}/{tests.length} have E2E
        </span>
        <span className="rounded bg-background-muted px-2 py-1">
          {withInt.length}/{tests.length} have INT
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-default">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-default bg-background-muted text-xs uppercase text-muted">
              <th className="px-3 py-2">Test Spec</th>
              <th className="px-3 py-2">Feature Status</th>
              <th className="px-3 py-2">Test Status</th>
              <th className="px-3 py-2 text-center">E2E</th>
              <th className="px-3 py-2 text-center">INT</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => {
              const feature = featureBySlug.get(t.featureSlug);
              const fStatus = feature?.status || '—';
              const statusColors: Record<string, string> = {
                STABLE: 'bg-emerald-500/15 text-emerald-400',
                BETA: 'bg-blue-500/15 text-blue-400',
                ALPHA: 'bg-amber-500/15 text-amber-400',
                PLANNED: 'bg-zinc-500/15 text-zinc-400',
              };
              return (
                <tr
                  key={t.slug}
                  className="border-b border-default last:border-0 transition-colors hover:bg-background-muted/50"
                >
                  <td className="px-3 py-2 font-medium">
                    <a
                      href={`/docs/testing/${t.slug}`}
                      className="text-foreground hover:text-accent"
                    >
                      {t.title}
                    </a>
                  </td>
                  <td className="px-3 py-2">
                    {fStatus !== '—' ? (
                      <a
                        href={`/docs/features/${t.featureSlug}`}
                        className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium hover:underline ${statusColors[fStatus] || 'text-muted'}`}
                      >
                        {fStatus}
                      </a>
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </td>
                  <td className="max-w-[200px] truncate px-3 py-2 text-xs text-muted">
                    {t.status}
                  </td>
                  <td className="px-3 py-2 text-center text-muted">
                    {t.e2eCount > 0 ? t.e2eCount : '—'}
                  </td>
                  <td className="px-3 py-2 text-center text-muted">
                    {t.intCount > 0 ? t.intCount : '—'}
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
