/**
 * Reads feature specs and test specs from the monorepo docs/ directory
 * (the source of truth) instead of duplicated MDX content files.
 *
 * Path resolution:
 *  - Dev:        cwd = <monorepo>/apps/studio  → ../../docs/
 *  - Standalone: cwd = /app/apps/studio        → ../../docs/  (docs/ copied to /app/docs/ in Dockerfile)
 */
import { promises as fs } from 'fs';
import path from 'path';

const MONOREPO_ROOT = path.resolve(process.cwd(), '../..');

export interface FeatureDoc {
  slug: string;
  title: string;
  status: string;
  specPath: string;
}

export interface TestDoc {
  slug: string;
  title: string;
  status: string;
  e2eCount: number;
  intCount: number;
  specPath: string;
  featureSlug: string;
}

function extractTitle(content: string, slug: string): string {
  // Try "# Title" on first line
  const h1Match = content.match(
    /^#\s+(?:Feature Spec(?:ification)?:|Test (?:Spec(?:ification)?|Guide):?\s*)?(.+)/m,
  );
  if (h1Match) return h1Match[1].trim();
  // Try "**Feature**: ..."
  const featureMatch = content.match(/\*\*Feature\*\*:\s*(.+)/);
  if (featureMatch) return featureMatch[1].trim().split('--')[0].trim();
  // Fallback: humanize slug
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractStatus(content: string): string {
  // Match **Status:** STABLE or > **Status:** ALPHA etc.
  const statusMatch = content.match(/\*\*Status:?\*\*:?\s*(STABLE|BETA|ALPHA|PLANNED)/i);
  if (statusMatch) return statusMatch[1].toUpperCase();
  // Try "Status: STABLE" without bold
  const plainMatch = content.match(/Status:\s*(STABLE|BETA|ALPHA|PLANNED)/i);
  if (plainMatch) return plainMatch[1].toUpperCase();
  return 'UNKNOWN';
}

function extractTestStatus(content: string): string {
  const statusMatch = content.match(/\*\*Status:?\*\*:?\s*(\S+.*)/i);
  if (statusMatch) return statusMatch[1].trim();
  const overallMatch = content.match(/Overall status\*\*:\s*(.+)/i);
  if (overallMatch) return overallMatch[1].trim();
  return '--';
}

function countScenarios(content: string, prefix: string): number {
  // Count lines like "### E2E-1:", "### E2E-2:", etc.
  const re = new RegExp(`^###\\s+${prefix}-\\d+`, 'gm');
  const matches = content.match(re);
  return matches ? matches.length : 0;
}

export interface FullDoc {
  slug: string;
  title: string;
  status: string;
  content: string;
}

/**
 * Strip the first H1 line from content (we render it separately).
 */
function stripH1(content: string): string {
  return content.replace(/^#\s+.+\n?/, '').trimStart();
}

export async function getFeatureDoc(slug: string): Promise<FullDoc | null> {
  const filePath = path.join(MONOREPO_ROOT, 'docs/features', `${slug}.md`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return {
      slug,
      title: extractTitle(raw, slug),
      status: extractStatus(raw),
      content: stripH1(raw),
    };
  } catch {
    return null;
  }
}

export async function getTestDoc(slug: string): Promise<FullDoc | null> {
  const filePath = path.join(MONOREPO_ROOT, 'docs/testing', `${slug}.md`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return {
      slug,
      title: extractTitle(raw, slug),
      status: extractTestStatus(raw),
      content: stripH1(raw),
    };
  } catch {
    return null;
  }
}

const SKIP_FILES = new Set(['README.md', 'TEMPLATE.md', 'AUTHORING_GUIDE.md', 'index.md']);

export async function getFeatureDocs(): Promise<FeatureDoc[]> {
  const dir = path.join(MONOREPO_ROOT, 'docs/features');
  const entries = await fs.readdir(dir);
  const mdFiles = entries.filter((f) => f.endsWith('.md') && !SKIP_FILES.has(f));

  const docs = await Promise.all(
    mdFiles.map(async (file) => {
      const slug = file.replace(/\.md$/, '');
      const filePath = path.join(dir, file);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        return {
          slug,
          title: extractTitle(content, slug),
          status: extractStatus(content),
          specPath: `docs/features/${file}`,
        };
      } catch {
        return null;
      }
    }),
  );

  return docs
    .filter((d): d is FeatureDoc => d !== null)
    .sort((a, b) => a.title.localeCompare(b.title));
}

export async function getTestDocs(): Promise<TestDoc[]> {
  const dir = path.join(MONOREPO_ROOT, 'docs/testing');
  const entries = await fs.readdir(dir);
  const mdFiles = entries.filter((f) => f.endsWith('.md') && !SKIP_FILES.has(f));

  const docs = await Promise.all(
    mdFiles.map(async (file) => {
      const slug = file.replace(/\.md$/, '');
      const filePath = path.join(dir, file);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        return {
          slug,
          title: extractTitle(content, slug),
          status: extractTestStatus(content),
          e2eCount: countScenarios(content, 'E2E'),
          intCount: countScenarios(content, 'INT'),
          specPath: `docs/testing/${file}`,
          featureSlug: slug,
        };
      } catch {
        return null;
      }
    }),
  );

  return docs
    .filter((d): d is TestDoc => d !== null)
    .sort((a, b) => a.title.localeCompare(b.title));
}
