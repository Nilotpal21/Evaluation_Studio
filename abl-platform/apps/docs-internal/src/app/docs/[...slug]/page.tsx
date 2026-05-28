import { notFound } from 'next/navigation';
import { MDXRemote } from 'next-mdx-remote/rsc';
import remarkGfm from 'remark-gfm';
import { getDocPage } from '../../../lib/content';
import { mdxComponents } from '../../../components/mdx';

interface PageProps {
  params: Promise<{ slug: string[] }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const section = slug[0];
  const pageSlug = slug[1] || 'index';
  const page = await getDocPage(section, pageSlug);

  if (!page) {
    return { title: 'Not Found' };
  }

  return { title: page.title };
}

export default async function DocPageRoute({ params }: PageProps) {
  const { slug } = await params;
  const section = slug[0];
  const pageSlug = slug[1] || 'index';
  const page = await getDocPage(section, pageSlug);

  if (!page) {
    notFound();
  }

  return (
    <article className="rounded-xl bg-white p-8 shadow-sm ring-1 ring-[hsl(220,3%,90%)]">
      <div className="prose prose-slate max-w-none">
        <h1>{page.title}</h1>
        {page.description && <p className="text-lg text-[hsl(220,3%,44%)]">{page.description}</p>}
        <MDXRemote
          source={page.content}
          components={mdxComponents}
          options={{ mdxOptions: { format: 'md', remarkPlugins: [remarkGfm] } }}
        />
      </div>
    </article>
  );
}
