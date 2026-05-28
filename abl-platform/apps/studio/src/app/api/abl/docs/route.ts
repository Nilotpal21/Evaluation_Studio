/**
 * ABL Documentation API Route
 *
 * Serves docs from the docs-internal content directory (81+ pages across 18 sections).
 *
 * GET /api/abl/docs                         — returns full topic index grouped by section
 * GET /api/abl/docs?topic=section/slug      — returns markdown content for a page
 * GET /api/abl/docs?search=Q               — searches across all pages
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import matter from 'gray-matter';

// ---------------------------------------------------------------------------
// Docs content directory — co-located in the docs-internal app.
// Keep this deterministic for Turbopack output-file tracing.
// ---------------------------------------------------------------------------

const CONTENT_DIR = path.resolve(process.cwd(), '../docs-internal/content');

// ---------------------------------------------------------------------------
// Sections config — mirrors docs-internal/docs.config.json
// ---------------------------------------------------------------------------

const SECTIONS = [
  { slug: 'getting-started', title: 'Getting Started' },
  { slug: 'tutorials', title: 'Tutorials' },
  { slug: 'guides', title: 'Guides' },
  { slug: 'abl-reference', title: 'ABL Language Reference' },
  { slug: 'studio', title: 'Studio' },
  { slug: 'admin', title: 'Administration' },
  { slug: 'api-reference', title: 'API Reference' },
  { slug: 'examples', title: 'Examples' },
  { slug: 'features', title: 'Features' },
  { slug: 'testing', title: 'Testing' },
  { slug: 'architecture', title: 'Architecture' },
  { slug: 'migration', title: 'Migration Strategy' },
  { slug: 'product', title: 'Product Readiness' },
  { slug: 'enterprise', title: 'Enterprise Readiness' },
  { slug: 'runtime', title: 'Runtime' },
  { slug: 'search-ai', title: 'SearchAI' },
  { slug: 'faq', title: 'FAQ' },
  { slug: 'glossary', title: 'Glossary' },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TopicMeta {
  id: string;
  title: string;
  category: string;
  description?: string;
  order?: number;
}

// ---------------------------------------------------------------------------
// Cache — populated lazily on first request
// ---------------------------------------------------------------------------

let topicIndexCache: TopicMeta[] | null = null;
let topicContentCache: Map<string, { meta: TopicMeta; content: string }> | null = null;

async function loadAllDocs(): Promise<{
  index: TopicMeta[];
  content: Map<string, { meta: TopicMeta; content: string }>;
}> {
  if (topicIndexCache && topicContentCache) {
    return { index: topicIndexCache, content: topicContentCache };
  }

  try {
    await fs.access(CONTENT_DIR);
  } catch {
    throw new Error(`Docs content directory not found at: ${CONTENT_DIR}`);
  }
  const index: TopicMeta[] = [];
  const content = new Map<string, { meta: TopicMeta; content: string }>();

  for (const section of SECTIONS) {
    const sectionDir = path.join(CONTENT_DIR, section.slug);
    let entries: string[];
    try {
      entries = await fs.readdir(sectionDir);
    } catch {
      continue;
    }

    const mdxFiles = entries.filter((f) => f.endsWith('.mdx') || f.endsWith('.md'));

    for (const file of mdxFiles) {
      const slug = file.replace(/\.mdx?$/, '');
      const id = `${section.slug}/${slug}`;
      const filePath = path.join(sectionDir, file);

      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const { data, content: body } = matter(raw);

        const meta: TopicMeta = {
          id,
          title: (data.title as string) || slug,
          category: section.title,
          description: (data.description as string) || undefined,
          order: (data.order as number) || undefined,
        };

        index.push(meta);
        content.set(id, { meta, content: body });
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Sort within each section by order, then alphabetically
  index.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return (a.order ?? 999) - (b.order ?? 999);
  });

  topicIndexCache = index;
  topicContentCache = content;

  return { index, content };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { searchParams } = new URL(request.url);
  const topic = searchParams.get('topic');
  const search = searchParams.get('search');

  try {
    const { index, content } = await loadAllDocs();

    // Return topic index when no query parameters are provided
    if (!topic && !search) {
      return NextResponse.json({ success: true, topics: index, total: index.length });
    }

    // Return specific topic content
    if (topic) {
      const entry = content.get(topic);
      if (!entry) {
        return NextResponse.json(
          { success: false, error: `Unknown topic: ${topic}` },
          { status: 404 },
        );
      }
      return NextResponse.json({
        success: true,
        topic: {
          id: entry.meta.id,
          title: entry.meta.title,
          category: entry.meta.category,
          content: entry.content,
        },
      });
    }

    // Search across topics
    if (search) {
      const lowerSearch = search.toLowerCase();
      const results: Array<{ id: string; title: string; category: string; excerpt: string }> = [];

      for (const [id, entry] of content.entries()) {
        const lowerContent = entry.content.toLowerCase();
        const lowerTitle = entry.meta.title.toLowerCase();
        const titleMatch = lowerTitle.includes(lowerSearch);
        const contentIdx = lowerContent.indexOf(lowerSearch);

        if (titleMatch || contentIdx !== -1) {
          const matchIdx = contentIdx !== -1 ? contentIdx : 0;
          const start = Math.max(0, matchIdx - 80);
          const end = Math.min(entry.content.length, matchIdx + search.length + 80);
          const excerpt =
            (start > 0 ? '...' : '') +
            entry.content.slice(start, end).trim() +
            (end < entry.content.length ? '...' : '');

          results.push({
            id,
            title: entry.meta.title,
            category: entry.meta.category,
            excerpt,
          });
        }
      }

      return NextResponse.json({ success: true, results, resultCount: results.length });
    }

    return NextResponse.json({ success: true, topics: index, total: index.length });
  } catch (error) {
    console.error('[abl-docs] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load docs',
      },
      { status: 500 },
    );
  }
}
