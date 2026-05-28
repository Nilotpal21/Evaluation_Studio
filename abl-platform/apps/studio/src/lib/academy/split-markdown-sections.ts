/**
 * Splits a markdown document into navigable sections based on h2 (##) headings.
 *
 * Content before the first h2 becomes the "intro" section.
 * Each subsequent h2 heading starts a new section.
 */

export interface MarkdownSection {
  /** URL-safe slug derived from heading text, or "intro" for content before the first h2 */
  id: string;
  /** Heading text (e.g., "The EXECUTION Block"), or the module title for intro */
  title: string;
  /** Markdown content from this heading to the next h2 (or end of document) */
  content: string;
}

/** Convert heading text to a URL-safe slug. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Split markdown content into sections on h2 (`## `) boundaries.
 *
 * @param markdown  Full markdown content string
 * @param introTitle  Title to use for the intro section (content before first h2)
 * @returns Array of MarkdownSection objects
 */
export function splitMarkdownSections(
  markdown: string,
  introTitle: string = 'Introduction',
): MarkdownSection[] {
  if (!markdown.trim()) return [];

  const lines = markdown.split('\n');
  const sections: MarkdownSection[] = [];

  let currentTitle = introTitle;
  let currentId = 'intro';
  let currentLines: string[] = [];

  for (const line of lines) {
    const h2Match = line.match(/^## (.+)$/);
    if (h2Match) {
      // Flush the previous section
      const content = currentLines.join('\n').trim();
      if (content || sections.length > 0) {
        sections.push({ id: currentId, title: currentTitle, content });
      }
      // Start new section
      currentTitle = h2Match[1].trim();
      currentId = slugify(currentTitle);
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Flush the last section
  const lastContent = currentLines.join('\n').trim();
  if (lastContent || sections.length > 0) {
    sections.push({ id: currentId, title: currentTitle, content: lastContent });
  }

  // If there was no content before the first h2 and the intro is empty, remove it
  if (sections.length > 0 && sections[0].id === 'intro' && !sections[0].content) {
    sections.shift();
  }

  return sections;
}
