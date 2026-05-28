#!/usr/bin/env npx tsx
/**
 * Convert _raw/*.json into _md/<KEY>.md for human/agent reading.
 * Uses the renderedFields HTML (description) and renderedBody (comments),
 * stripped to plain-ish text.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const RAW_DIR = join(process.cwd(), 'docs/sdlc-logs/triage-2026-05-16/_raw');
const OUT_DIR = join(process.cwd(), 'docs/sdlc-logs/triage-2026-05-16/_md');

function htmlToText(html: string | null | undefined): string {
  if (!html) return '(empty)';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(
      /<\/?(h[1-6]|strong|em|b|i|u|code|pre|ul|ol|p|div|span|a|blockquote|table|tbody|thead|tr|th|td|hr)[^>]*>/gi,
      '',
    )
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface RawTicket {
  issue: {
    key: string;
    fields: {
      summary: string;
      status: { name: string };
      assignee: { displayName: string } | null;
      reporter: { displayName: string } | null;
      priority: { name: string } | null;
      labels: string[];
      created: string;
      updated: string;
      duedate: string | null;
    };
    renderedFields: { description: string | null };
  };
  comments: {
    comments: Array<{
      author: { displayName: string };
      created: string;
      renderedBody?: string;
    }>;
    total: number;
  };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const files = (await readdir(RAW_DIR)).filter((f) => f.endsWith('.json')).sort();
  for (const file of files) {
    const raw = JSON.parse(await readFile(join(RAW_DIR, file), 'utf8')) as RawTicket;
    const f = raw.issue.fields;
    const lines: string[] = [];
    lines.push(`# ${raw.issue.key} — ${f.summary}`);
    lines.push('');
    lines.push(`- Status: ${f.status.name}`);
    lines.push(`- Assignee: ${f.assignee?.displayName ?? '(unassigned)'}`);
    lines.push(`- Reporter: ${f.reporter?.displayName ?? '(unknown)'}`);
    lines.push(`- Priority: ${f.priority?.name ?? '(none)'}`);
    lines.push(`- Labels: ${f.labels.join(', ') || '(none)'}`);
    lines.push(`- Created: ${f.created}`);
    lines.push(`- Updated: ${f.updated}`);
    lines.push(`- Due: ${f.duedate ?? '(none)'}`);
    lines.push('');
    lines.push('## Description');
    lines.push('');
    lines.push(htmlToText(raw.issue.renderedFields.description));
    lines.push('');
    lines.push(`## Comments (${raw.comments.total})`);
    for (const c of raw.comments.comments) {
      lines.push('');
      lines.push(`### ${c.author.displayName} — ${c.created}`);
      lines.push('');
      lines.push(htmlToText(c.renderedBody));
    }
    const outPath = join(OUT_DIR, `${raw.issue.key}.md`);
    await writeFile(outPath, lines.join('\n'));
    console.log(`[ok] ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
