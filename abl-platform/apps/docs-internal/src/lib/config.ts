import { readFileSync } from 'fs';
import path from 'path';

export interface DocsConfig {
  allowedDomains: string[];
  siteName: string;
  sections: Array<{
    slug: string;
    title: string;
  }>;
}

let cached: DocsConfig | null = null;

export function getDocsConfig(): DocsConfig {
  if (!cached) {
    const configPath = path.join(process.cwd(), 'docs.config.json');
    cached = JSON.parse(readFileSync(configPath, 'utf-8')) as DocsConfig;
  }
  return cached;
}
