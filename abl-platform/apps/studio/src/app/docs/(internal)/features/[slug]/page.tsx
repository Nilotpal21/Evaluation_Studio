import { notFound } from 'next/navigation';
import { MDXRemote } from 'next-mdx-remote/rsc';
import remarkGfm from 'remark-gfm';
import type { Metadata } from 'next';
import { getFeatureDoc } from '../../../../../lib/docs/source-docs';
import { getDocPage } from '../../../../../lib/docs/content';
import { createMdxComponents } from '../../../../../components/docs/mdx';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const doc = await getFeatureDoc(slug);
  if (doc) return { title: `${doc.title} — Feature Spec` };
  const mdx = await getDocPage('features', slug);
  if (mdx) return { title: `${mdx.title} — Internal Docs` };
  return { title: 'Not Found' };
}

const STATUS_COLORS: Record<string, string> = {
  STABLE: 'bg-emerald-500/15 text-emerald-400',
  BETA: 'bg-blue-500/15 text-blue-400',
  ALPHA: 'bg-amber-500/15 text-amber-400',
  PLANNED: 'bg-zinc-500/15 text-zinc-400',
  UNKNOWN: 'bg-red-500/15 text-red-400',
};

export default async function FeatureDetailPage({ params }: Props) {
  const { slug } = await params;

  if (slug === 'index') {
    const { default: FeaturesPage } = await import('../page');
    return <FeaturesPage />;
  }

  // Try source-of-truth doc first
  const doc = await getFeatureDoc(slug);
  if (doc) {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-center gap-3">
          <a
            href="/docs/features"
            className="text-sm text-muted transition-default hover:text-foreground"
          >
            ← All Features
          </a>
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[doc.status] || STATUS_COLORS.UNKNOWN}`}
          >
            {doc.status}
          </span>
        </div>
        <h1 className="mb-2 text-3xl font-bold text-foreground">{doc.title}</h1>
        <p className="mb-8 text-xs text-muted">
          Source: <code>docs/features/{slug}.md</code>
        </p>
        <article className="docs-prose prose max-w-none dark:prose-invert">
          <MDXRemote
            source={doc.content}
            components={createMdxComponents({ section: 'features', slug })}
            options={{ mdxOptions: { format: 'md', remarkPlugins: [remarkGfm] } }}
          />
        </article>
      </div>
    );
  }

  // Fallback to MDX content system (e.g. content/features/*.mdx)
  const mdx = await getDocPage('features', slug);
  if (mdx) {
    return (
      <div>
        <h1 className="mb-2 text-3xl font-bold text-foreground">{mdx.title}</h1>
        {mdx.description && <p className="mb-8 text-lg text-muted">{mdx.description}</p>}
        <MDXRemote
          source={mdx.content}
          components={createMdxComponents({ section: mdx.section, slug: mdx.slug })}
          options={{ mdxOptions: { format: 'md', remarkPlugins: [remarkGfm] } }}
        />
      </div>
    );
  }

  notFound();
}
