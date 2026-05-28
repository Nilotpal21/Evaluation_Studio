import { notFound } from 'next/navigation';
import { MDXRemote } from 'next-mdx-remote/rsc';
import remarkGfm from 'remark-gfm';
import type { Metadata } from 'next';
import { getTestDoc } from '../../../../../lib/docs/source-docs';
import { getDocPage } from '../../../../../lib/docs/content';
import { createMdxComponents } from '../../../../../components/docs/mdx';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const doc = await getTestDoc(slug);
  if (doc) return { title: `${doc.title} — Test Spec` };
  const mdx = await getDocPage('testing', slug);
  if (mdx) return { title: `${mdx.title} — Internal Docs` };
  return { title: 'Not Found' };
}

export default async function TestDetailPage({ params }: Props) {
  const { slug } = await params;

  if (slug === 'index') {
    const { default: TestingPage } = await import('../page');
    return <TestingPage />;
  }

  // Try source-of-truth doc first
  const doc = await getTestDoc(slug);
  if (doc) {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-center gap-3">
          <a
            href="/docs/testing"
            className="text-sm text-muted transition-default hover:text-foreground"
          >
            ← All Test Specs
          </a>
        </div>
        <h1 className="mb-2 text-3xl font-bold text-foreground">{doc.title}</h1>
        <p className="mb-8 text-xs text-muted">
          Source: <code>docs/testing/{slug}.md</code>
        </p>
        <article className="docs-prose prose max-w-none dark:prose-invert">
          <MDXRemote
            source={doc.content}
            components={createMdxComponents({ section: 'testing', slug })}
            options={{ mdxOptions: { format: 'md', remarkPlugins: [remarkGfm] } }}
          />
        </article>
      </div>
    );
  }

  // Fallback to MDX content system (e.g. content/testing/standards.mdx)
  const mdx = await getDocPage('testing', slug);
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
