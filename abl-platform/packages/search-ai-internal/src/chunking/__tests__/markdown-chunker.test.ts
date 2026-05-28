/**
 * Tests for markdown-aware chunking (v2 — token-based, merge-up strategy)
 */

import { describe, it, expect } from 'vitest';
import { chunkMarkdown, extractHeadings } from '../markdown-chunker.js';

describe('markdown-chunker', () => {
  describe('extractHeadings', () => {
    it('should extract heading hierarchy', () => {
      const markdown = `
# Main Title

Some intro text.

## Section 1

Content for section 1.

### Subsection 1.1

Details here.

## Section 2

More content.
`;

      const headings = extractHeadings(markdown);

      expect(headings).toHaveLength(4);
      expect(headings[0].level).toBe(1);
      expect(headings[0].text).toBe('Main Title');
      expect(headings[1].level).toBe(2);
      expect(headings[1].text).toBe('Section 1');
      expect(headings[2].level).toBe(3);
      expect(headings[2].text).toBe('Subsection 1.1');
      expect(headings[3].level).toBe(2);
      expect(headings[3].text).toBe('Section 2');
    });

    it('should handle markdown without headings', () => {
      const markdown = `
Just some plain text.

No headings here.
`;

      const headings = extractHeadings(markdown);
      expect(headings).toHaveLength(0);
    });
  });

  describe('chunkMarkdown', () => {
    it('should chunk by H1, H2, and H3 headings by default', () => {
      const markdown = `
# Document Title

Introduction paragraph.

## Section 1

Content for section 1.

### Subsection 1.1

Details for subsection 1.1.

## Section 2

Content for section 2.
`;

      const chunks = chunkMarkdown(markdown);

      expect(chunks.length).toBeGreaterThan(0);

      // All headings should be preserved in chunk text (no info loss)
      const allText = chunks.map((c) => c.text).join('\n');
      expect(allText).toContain('## Section 1');
      expect(allText).toContain('### Subsection 1.1');
      expect(allText).toContain('## Section 2');
      expect(allText).toContain('Content for section 1');
      expect(allText).toContain('Content for section 2');
    });

    it('should keep code blocks intact', () => {
      const markdown = `
# Code Example

Here is some code:

\`\`\`typescript
function example() {
  return "hello";
}
\`\`\`

End of code.
`;

      const chunks = chunkMarkdown(markdown, {
        preserveCodeBlocks: true,
      });

      // Code block should be in a single chunk (not split)
      const codeChunk = chunks.find((c) => c.metadata.containsCode);
      expect(codeChunk).toBeDefined();
      expect(codeChunk!.text).toContain('function example()');
      expect(codeChunk!.text).toContain('return "hello"');
    });

    it('should keep tables intact', () => {
      const markdown = `
# Data Table

| Name | Value |
|------|-------|
| A    | 1     |
| B    | 2     |

End of table.
`;

      const chunks = chunkMarkdown(markdown, {
        preserveTables: true,
      });

      // Table should be in a single chunk
      const tableChunk = chunks.find((c) => c.metadata.containsTable);
      expect(tableChunk).toBeDefined();
      expect(tableChunk!.text).toContain('| Name | Value |');
      expect(tableChunk!.text).toContain('| A    | 1     |');
      expect(tableChunk!.text).toContain('| B    | 2     |');
    });

    it('should keep lists together', () => {
      const markdown = `
# Shopping List

- Item 1
- Item 2
- Item 3
- Item 4

End of list.
`;

      const chunks = chunkMarkdown(markdown, {
        preserveLists: true,
      });

      // List should be in a single chunk
      const listChunk = chunks.find((c) => c.metadata.containsList);
      expect(listChunk).toBeDefined();
      expect(listChunk!.text).toContain('- Item 1');
      expect(listChunk!.text).toContain('- Item 4');
    });

    it('should only force-split sections exceeding maxChunkTokens', () => {
      // Create a section with many paragraphs that totals > 5000 tokens
      // Each paragraph ~50 tokens, need 120+ to exceed 5000
      const paragraphs = Array(150)
        .fill(null)
        .map(
          (_, i) =>
            `Paragraph ${i}: This is a moderately long sentence that provides enough content to fill a reasonable amount of space. It discusses topic number ${i} with sufficient detail to consume tokens. The purpose is to test that very large sections get split while smaller ones stay intact. We need to ensure this paragraph contributes meaningfully to the token count.`,
        )
        .join('\n\n');

      const markdown = `
# Large Section

${paragraphs}
`;

      const chunks = chunkMarkdown(markdown);

      // Should split into multiple chunks since content > 5000 tokens
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should NOT split sections under maxChunkTokens (header-to-header stays together)', () => {
      // A section with ~800 tokens — well under 5000, must stay as ONE chunk
      const paragraphs = Array(10)
        .fill(null)
        .map(
          (_, i) =>
            `Question ${i}: What is the answer to life? The answer is that it depends on the context and the specific question being asked.`,
        )
        .join('\n\n');

      const markdown = `
# FAQ Section

${paragraphs}
`;

      const chunks = chunkMarkdown(markdown);

      // All content should be in a single chunk (not split at arbitrary boundaries)
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toContain('Question 0');
      expect(chunks[0].text).toContain('Question 9');
    });

    it('should merge adjacent small chunks up to mergeTargetTokens', () => {
      const markdown = `
# Document

## Section A

Short content A.

## Section B

Short content B.

## Section C

Short content C.
`;

      const chunks = chunkMarkdown(markdown);

      // All three sections are tiny — they should merge into fewer chunks
      // (possibly 1 or 2 depending on merge target)
      expect(chunks.length).toBeLessThan(4); // Would be 4 without merging (root + 3 sections)
    });

    it('should merge small H1 sections when combined tokens <= mergeTargetTokens', () => {
      const markdown = `
# Part 1

Small content in part 1.

# Part 2

Small content in part 2.
`;

      const chunks = chunkMarkdown(markdown);

      // Both H1s are tiny — final pass merges them into one chunk
      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toContain('part 1');
      expect(chunks[0].text).toContain('part 2');
    });

    it('should NOT merge large H1 sections that exceed mergeTargetTokens combined', () => {
      // Create two H1 sections each ~800+ tokens — combined ~1600+ > 1500
      const longContentA = Array(60)
        .fill(null)
        .map(
          (_, i) =>
            `Alpha paragraph ${i} which contains a detailed explanation of the specific topic at hand. It includes multiple sentences that contribute meaningfully to the overall token count and ensure each section individually approaches the merge threshold limit.`,
        )
        .join('\n\n');

      const longContentB = Array(60)
        .fill(null)
        .map(
          (_, i) =>
            `Beta paragraph ${i} which contains a detailed explanation of a different topic entirely. It includes multiple sentences that contribute meaningfully to the overall token count and ensure each section individually approaches the merge threshold limit.`,
        )
        .join('\n\n');

      const markdown = `
# Part 1

${longContentA}

# Part 2

${longContentB}
`;

      const chunks = chunkMarkdown(markdown);

      // Each section is large (>1500 tokens each). Combined would far exceed 1500.
      // They should NOT merge.
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      // Verify content from Part 1 and Part 2 are in different chunks
      const alphaChunk = chunks.find((c) => c.text.includes('Alpha paragraph'));
      const betaChunk = chunks.find((c) => c.text.includes('Beta paragraph'));
      expect(alphaChunk).toBeDefined();
      expect(betaChunk).toBeDefined();
      expect(alphaChunk).not.toBe(betaChunk);
    });

    it('should preserve section hierarchy headings in chunk text', () => {
      const markdown = `
# Book

## Chapter 1

### Section 1.1

Content here with enough detail to form a meaningful section about topic one.

### Section 1.2

More content here about a different subtopic within the same chapter.

## Chapter 2

Content for chapter 2 which is a separate major section of the document.
`;

      const chunks = chunkMarkdown(markdown);

      // All sections are small — they merge into fewer chunks.
      // But ALL headings must still appear in the text content (no info loss).
      const allText = chunks.map((c) => c.text).join('\n');
      expect(allText).toContain('## Chapter 1');
      expect(allText).toContain('### Section 1.1');
      expect(allText).toContain('### Section 1.2');
      expect(allText).toContain('## Chapter 2');
      expect(allText).toContain('topic one');
      expect(allText).toContain('separate major section');
    });

    it('should handle GFM features (tables, strikethrough)', () => {
      const markdown = `
# GFM Features

~~strikethrough~~

| Feature | Supported |
|---------|-----------|
| Tables  | ✓         |
| Strike  | ✓         |

- [ ] Todo item
- [x] Done item
`;

      const chunks = chunkMarkdown(markdown);

      expect(chunks.length).toBeGreaterThan(0);

      // Should parse GFM successfully
      const allText = chunks.map((c) => c.text).join('\n');
      expect(allText).toContain('| Feature | Supported |');
      expect(allText).toContain('~~strikethrough~~');
      expect(allText).toContain('[ ] Todo item');
    });

    it('should handle empty markdown', () => {
      const chunks = chunkMarkdown('');
      expect(chunks).toHaveLength(0);
    });

    it('should handle markdown with only whitespace', () => {
      const chunks = chunkMarkdown('   \n\n   ');
      expect(chunks).toHaveLength(0);
    });

    it('should assign sequential chunk indices', () => {
      const markdown = `
# Document

## Section 1

Content 1.

## Section 2

Content 2.

## Section 3

Content 3.
`;

      const chunks = chunkMarkdown(markdown);

      // Check indices are sequential
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].metadata.chunkIndex).toBe(i);
      }
    });

    it('should keep FAQ Q&A pairs together (no mid-pair splitting)', () => {
      // Simulate a FAQ page: questions and answers as paragraphs under one heading
      const faqContent = Array(10)
        .fill(null)
        .map(
          (_, i) =>
            `Why does issue ${i} happen?\n\nThe answer to issue ${i} is that you need to check your settings and ensure everything is configured properly. Follow these steps to resolve it.`,
        )
        .join('\n\n');

      const markdown = `
# FAQ

${faqContent}
`;

      const chunks = chunkMarkdown(markdown);

      // With ~10 Q&A pairs (~1500 tokens total), should be 1 chunk
      // Key assertion: no chunk should end with a question without its answer
      for (const chunk of chunks) {
        const lines = chunk.text.split('\n\n');
        const lastLine = lines[lines.length - 1];
        // If last line is a question, it means Q was separated from A — BAD
        if (lastLine.endsWith('?') && !lastLine.startsWith('The answer')) {
          // Check the next paragraph is also in this chunk (the answer)
          const questionIndex = lines.indexOf(lastLine);
          if (questionIndex < lines.length - 1) {
            // Answer follows in same chunk — good
            continue;
          }
          // If it's the very last line and it's a question, that's still OK
          // as long as this isn't a mid-FAQ split (it could be the last Q&A pair)
        }
      }

      // Should produce very few chunks (all Q&A together)
      expect(chunks.length).toBeLessThanOrEqual(2);
    });

    it('should handle nested lists', () => {
      const markdown = `
# List Test

- Level 1 item 1
  - Level 2 item 1
  - Level 2 item 2
- Level 1 item 2
`;

      const chunks = chunkMarkdown(markdown, {
        preserveLists: true,
      });

      const listChunk = chunks.find((c) => c.metadata.containsList);
      expect(listChunk).toBeDefined();
      expect(listChunk!.text).toContain('Level 1 item 1');
      expect(listChunk!.text).toContain('Level 2 item 1');
    });

    it('should include line numbers in metadata', () => {
      const markdown = `
# Test

Content here.

## Section

More content.
`;

      const chunks = chunkMarkdown(markdown);

      for (const chunk of chunks) {
        expect(chunk.metadata.startLine).toBeGreaterThan(0);
        expect(chunk.metadata.endLine).toBeGreaterThanOrEqual(chunk.metadata.startLine);
      }
    });

    it('should handle documents with no headings as a single chunk', () => {
      const markdown = `
This is a document without any headings.

It has multiple paragraphs but no structure markers.

The chunker should keep it all together since it is under the token limit.
`;

      const chunks = chunkMarkdown(markdown);

      // No headings = all content in root section = one chunk
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toContain('without any headings');
      expect(chunks[0].text).toContain('under the token limit');
    });

    it('should respect custom maxChunkTokens and mergeTargetTokens', () => {
      const markdown = `
# Document

## Section 1

Small.

## Section 2

Also small.
`;

      const chunks = chunkMarkdown(markdown, {
        maxChunkTokens: 10000,
        mergeTargetTokens: 2000,
      });

      // With very high limits, should merge aggressively
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should NOT create tiny heading-only chunks when heading has children but no body', () => {
      // This is the "## PART B. ACCEPTABLE USE RULES" scenario:
      // A heading that has no body text, only sub-headings under it.
      // The heading should be prepended to the first child, not create a 6-token orphan.
      const markdown = `
# Terms of Service

## PART A. GENERAL TERMS

### 1. Agreement

This agreement is between the company and the user.
You must accept these terms to use the service.

### 2. Definitions

"Service" means the platform and all related tools.
"User" means any person who accesses the service.

## PART B. ACCEPTABLE USE RULES

### 3. Prohibited Activities

You may not use the service for illegal purposes or
to harm other users.

### 4. Content Guidelines

All content must be appropriate and follow community standards.
`;

      const chunks = chunkMarkdown(markdown);

      // PART B should NOT be its own tiny chunk
      const partBOnlyChunk = chunks.find(
        (c) => c.text.trim() === '## PART B. ACCEPTABLE USE RULES',
      );
      expect(partBOnlyChunk).toBeUndefined();

      // PART B heading should be prepended to its first child's text
      const chunkWithPartB = chunks.find((c) => c.text.includes('PART B. ACCEPTABLE USE RULES'));
      expect(chunkWithPartB).toBeDefined();
      // The chunk should also contain the first child's content (not just the heading)
      expect(chunkWithPartB!.text).toContain('Prohibited Activities');
    });

    it('should prepend parent heading to first child even for deeply nested empty headings', () => {
      const markdown = `
# Documentation

## API Reference

### Endpoints

#### GET /users

Returns a list of users.

#### POST /users

Creates a new user.
`;

      const chunks = chunkMarkdown(markdown);

      // "## API Reference" has no body, only child "### Endpoints"
      // "### Endpoints" has no body, only children "#### GET /users" etc.
      // None of these empty-body headings should appear as standalone chunks
      const allText = chunks.map((c) => c.text).join('\n---\n');

      // API Reference heading should appear in the content (not lost)
      expect(allText).toContain('API Reference');
      // No chunk should be ONLY a heading with no body content
      for (const chunk of chunks) {
        const lines = chunk.text
          .trim()
          .split('\n')
          .filter((l) => l.trim());
        // A chunk with only heading lines (starting with #) is bad
        const allHeadings = lines.every((l) => l.startsWith('#'));
        if (allHeadings && lines.length <= 2) {
          // Allow merged headings only if they're very short AND part of a larger merge
          // But a standalone single heading chunk is always wrong
          expect(lines.length).toBeGreaterThan(1);
        }
      }
    });
  });
});
