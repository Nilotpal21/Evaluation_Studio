import fs from 'fs/promises';
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

const DOCS_PATH_SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSafeDocsPathSegment(segment: string): boolean {
  return DOCS_PATH_SEGMENT_PATTERN.test(segment);
}

export function getContentDir(): string {
  return path.join(process.cwd(), 'content');
}

export async function getDocPage(section: string, slug: string): Promise<DocPage | null> {
  if (!isSafeDocsPathSegment(section) || !isSafeDocsPathSegment(slug)) {
    return null;
  }

  const filePath = path.join(getContentDir(), section, `${slug}.mdx`);

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const { data, content } = matter(raw);

    return {
      slug,
      title: (data.title as string) || slug,
      description: (data.description as string) || '',
      section,
      order: (data.order as number) ?? 0,
      content,
    };
  } catch {
    return null;
  }
}

export async function getSectionPages(sectionSlug: string): Promise<DocPage[]> {
  if (!isSafeDocsPathSegment(sectionSlug)) {
    return [];
  }

  const sectionDir = path.join(getContentDir(), sectionSlug);

  try {
    const entries = await fs.readdir(sectionDir);
    const mdxFiles = entries.filter((f) => f.endsWith('.mdx'));

    const pages = await Promise.all(
      mdxFiles.map(async (file) => {
        const slug = file.replace(/\.mdx$/, '');
        return getDocPage(sectionSlug, slug);
      }),
    );

    return pages.filter((p): p is DocPage => p !== null).sort((a, b) => a.order - b.order);
  } catch {
    return [];
  }
}

export async function getAllSections(): Promise<SectionWithPages[]> {
  const config = getDocsConfig();

  const sections = await Promise.all(
    config.sections.map(async (section) => {
      const pages = await getSectionPages(section.slug);
      return {
        slug: section.slug,
        title: section.title,
        pages,
      };
    }),
  );

  return sections;
}
