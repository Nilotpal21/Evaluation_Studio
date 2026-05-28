import { promises as fs } from 'fs';
import path from 'path';

export interface DocsConfig {
  siteName: string;
  sections: Array<{ slug: string; title: string }>;
}

/**
 * Async docs config loader. Reads docs.config.json from app root.
 * No caching — file is ~1KB, read-per-request is negligible.
 */
export async function getDocsConfig(): Promise<DocsConfig> {
  const configPath = path.join(process.cwd(), 'docs.config.json');
  const raw = await fs.readFile(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as DocsConfig;
  return {
    siteName: parsed.siteName || 'Internal Docs',
    sections: Array.isArray(parsed.sections) ? parsed.sections : [],
  };
}
