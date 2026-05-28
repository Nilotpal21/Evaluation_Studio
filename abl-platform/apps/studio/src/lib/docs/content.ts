import { promises as fs } from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { getDocsConfig } from './config';

export interface DocPage {
  slug: string;
  title: string;
  description: string;
  section: string;
  order: number;
  content: string;
}

export interface SectionWithPages {
  slug: string;
  title: string;
  pages: DocPage[];
}

function getContentDir(): string {
  // NOTE: __dirname is NOT available in ESM (Next.js uses ESM modules).
  // process.cwd() is correct for Next.js standalone builds.
  return path.join(process.cwd(), 'content');
}

export async function getDocPage(section: string, slug: string): Promise<DocPage | null> {
  const contentDir = getContentDir();
  const filePath = path.join(contentDir, section, `${slug}.mdx`);

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const { data, content } = matter(raw);
    return {
      slug,
      title: typeof data.title === 'string' ? data.title : slug,
      description: typeof data.description === 'string' ? data.description : '',
      section: typeof data.section === 'string' ? data.section : section,
      order: typeof data.order === 'number' ? data.order : 999,
      content,
    };
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function getSectionPages(sectionSlug: string): Promise<DocPage[]> {
  const contentDir = getContentDir();
  const sectionDir = path.join(contentDir, sectionSlug);

  try {
    const entries = await fs.readdir(sectionDir);
    const mdxFiles = entries.filter((f) => f.endsWith('.mdx'));

    const pages = await Promise.all(
      mdxFiles.map(async (file) => {
        const slug = file.replace(/\.mdx$/, '');
        try {
          return await getDocPage(sectionSlug, slug);
        } catch {
          // Skip files with parse errors (e.g., malformed YAML frontmatter)
          // so a single broken file doesn't break the entire section listing.
          return null;
        }
      }),
    );

    return pages.filter((p): p is DocPage => p !== null).sort((a, b) => a.order - b.order);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

export async function getAllSections(): Promise<SectionWithPages[]> {
  const config = await getDocsConfig();
  const sections = await Promise.all(
    config.sections.map(async (s) => ({
      slug: s.slug,
      title: s.title,
      pages: await getSectionPages(s.slug),
    })),
  );
  return sections;
}
