import { notFound } from 'next/navigation';
import { MDXRemote } from 'next-mdx-remote/rsc';
import remarkGfm from 'remark-gfm';
import { getDocPage } from '../../../../lib/docs/content';
import { createMdxComponents } from '../../../../components/docs/mdx';
import type { Metadata } from 'next';

interface DocsPageProps {
  params: Promise<{ slug: string[] }>;
}

async function resolveDoc(slugArray: string[]) {
  const section = slugArray[0];
  const page = slugArray[1] || 'index';

  // Try exact match first
  let doc = await getDocPage(section, page);
  if (doc) return doc;

  // For single-segment URLs like /docs/faq, try section/section.mdx
  if (slugArray.length === 1) {
    doc = await getDocPage(section, section);
    if (doc) return doc;
  }

  return null;
}

export async function generateMetadata({ params }: DocsPageProps): Promise<Metadata> {
  const { slug } = await params;
  const doc = await resolveDoc(slug);
  if (!doc) return { title: 'Not Found' };
  return {
    title: `${doc.title} — Internal Docs`,
    description: doc.description,
  };
}

export default async function DocsPage({ params }: DocsPageProps) {
  const { slug } = await params;
  const doc = await resolveDoc(slug);

  if (!doc) {
    notFound();
  }

  return (
    <div>
      <h1 className="mb-2 text-3xl font-bold text-foreground">{doc.title}</h1>
      {doc.description && <p className="mb-8 text-lg text-muted">{doc.description}</p>}
      <MDXRemote
        source={doc.content}
        components={createMdxComponents({ section: doc.section, slug: doc.slug })}
        options={{
          mdxOptions: {
            format: 'md',
            remarkPlugins: [remarkGfm],
          },
        }}
      />
    </div>
  );
}
