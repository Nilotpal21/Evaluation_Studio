/**
 * Markdown-Aware Chunking (v2)
 *
 * Structure-preserving chunking for markdown documents using unified/remark.
 * Respects document structure: headings, code blocks, tables, lists.
 *
 * Strategy (token-based, no arbitrary character limits):
 *   1. Split on heading boundaries (H1, H2, H3) — each heading starts a section
 *   2. Each section = heading + all content until the next heading of same/higher level
 *   3. If a section > MAX_CHUNK_TOKENS (5000) → recursive split into ~1500 token chunks
 *   4. If a section ≤ MAX_CHUNK_TOKENS → keep as single chunk
 *   5. Sibling merge: adjacent small chunks (< MERGE_TARGET_TOKENS) under same parent
 *      are merged until combined would exceed MERGE_TARGET_TOKENS.
 *   6. Aggressive merge: ANY adjacent small chunks merge if combined ≤ 1500 tokens (hierarchy-agnostic).
 *   7. Micro-chunk absorption: chunks < 100 tokens are force-merged into nearest neighbor.
 *
 * This ensures:
 *   - FAQ Q&A pairs never split apart (they're under same heading or same flat section)
 *   - Small sections merge into meaningful, readable chunks
 *   - Only truly massive sections get force-split
 *   - No arbitrary 1024-char mid-paragraph breaks
 *
 * Features:
 *   - Chunk by heading boundaries (H1, H2, H3)
 *   - Keep code blocks intact (never split mid-block)
 *   - Keep tables intact
 *   - Keep lists together
 *   - Add section hierarchy to chunk metadata
 *   - Token-safe: only splits sections exceeding MAX_CHUNK_TOKENS
 *   - Merge-up: small sections merge to produce substantial chunks
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type { Root, RootContent, Heading } from 'mdast';
import { countTokens } from '../tokenizer/index.js';

// ─── Token Constants ─────────────────────────────────────────────────────────────
/**
 * Maximum tokens per chunk before force-splitting.
 * BGE-M3 supports 8192 tokens. We use 5000 as a safe ceiling to leave
 * room for retrieval metadata, query concatenation, and overlap.
 */
const MAX_CHUNK_TOKENS = 5000;

/**
 * Target size when merging small sections.
 * Adjacent sections smaller than this are merged until combined exceeds this.
 * 1500 tokens ≈ good retrieval granularity while avoiding micro-chunks.
 */
const MERGE_TARGET_TOKENS = 1500;

/**
 * Target chunk size when force-splitting oversized sections.
 * When a section exceeds MAX_CHUNK_TOKENS, fill the first chunk to MAX_CHUNK_TOKENS
 * and put the remainder in the next chunk. This maximizes context per chunk.
 * Example: 8000 tokens → chunk 1 (5000) + chunk 2 (3000).
 */
const TARGET_SPLIT_TOKENS = MAX_CHUNK_TOKENS;

/**
 * Overlap between recursive split chunks for context continuity.
 */
const OVERLAP_TOKENS = 200;

/**
 * Minimum tokens for a chunk to exist standalone.
 * Chunks below this threshold are force-merged with their nearest neighbor
 * regardless of section hierarchy. Prevents useless micro-chunks (6 tokens,
 * 25 tokens, 52 tokens) that add noise to vector search without providing value.
 * 100 tokens ≈ 2-3 sentences — minimum for a meaningful search result.
 */
const MIN_CHUNK_TOKENS = 100;

/**
 * Approximate chars-per-token for estimating character limits from token targets.
 * cl100k_base averages ~4 chars/token for English text.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Heading information with hierarchy
 */
export interface HeadingNode {
  level: number;
  text: string;
  position: {
    start: { line: number; column: number; offset?: number };
    end: { line: number; column: number; offset?: number };
  };
}

/**
 * Markdown chunk with metadata
 */
export interface MarkdownChunk {
  text: string;
  metadata: {
    sectionPath: string[]; // Heading hierarchy: ["H1", "H2", "H3"]
    containsCode: boolean;
    containsTable: boolean;
    containsList: boolean;
    startLine: number;
    endLine: number;
    chunkIndex: number;
  };
}

/**
 * Chunking options
 */
export interface MarkdownChunkOptions {
  /** Heading levels to split on (default: [1, 2, 3]) */
  headingLevels?: number[];
  /** Keep code blocks intact (default: true) */
  preserveCodeBlocks?: boolean;
  /** Keep tables intact (default: true) */
  preserveTables?: boolean;
  /** Keep lists together (default: true) */
  preserveLists?: boolean;
  /** Max tokens before force-splitting a section (default: 5000) */
  maxChunkTokens?: number;
  /** Target tokens when merging small sections (default: 1500) */
  mergeTargetTokens?: number;
}

/**
 * Section node representing a document section
 */
interface SectionNode {
  heading?: HeadingNode;
  content: string;
  children: SectionNode[];
  startLine: number;
  endLine: number;
  containsCode: boolean;
  containsTable: boolean;
  containsList: boolean;
}

/**
 * Parse markdown to AST and extract structure
 */
function parseMarkdown(markdown: string): Root {
  const processor = unified().use(remarkParse).use(remarkGfm);
  return processor.parse(markdown) as Root;
}

/**
 * Extract text content from a node
 */
function extractText(node: RootContent, markdown: string): string {
  if (!node.position) {
    return '';
  }

  const start = node.position.start.offset ?? 0;
  const end = node.position.end.offset ?? 0;

  return markdown.slice(start, end);
}

/**
 * Extract heading text from heading node
 */
function extractHeadingText(node: Heading): string {
  return node.children
    .map((child: any) => {
      if ('value' in child) {
        return child.value;
      }
      return '';
    })
    .join('');
}

/**
 * Build section hierarchy from AST
 */
function buildSectionHierarchy(
  ast: Root,
  markdown: string,
  options: Required<MarkdownChunkOptions>,
): SectionNode {
  const root: SectionNode = {
    content: '',
    children: [],
    startLine: 1,
    endLine: markdown.split('\n').length,
    containsCode: false,
    containsTable: false,
    containsList: false,
  };

  const sectionStack: SectionNode[] = [root];
  let currentSection = root;

  // Track current content buffer
  let contentBuffer: RootContent[] = [];

  const flushContent = () => {
    if (contentBuffer.length > 0) {
      const contentText = contentBuffer.map((node) => extractText(node, markdown)).join('\n\n');
      currentSection.content += (currentSection.content ? '\n\n' : '') + contentText;
      contentBuffer = [];
    }
  };

  visit(ast, (node) => {
    if (node.type === 'heading') {
      const heading = node as Heading;

      // Check if this heading level triggers a section break
      if (options.headingLevels.includes(heading.depth)) {
        // Flush any pending content to current section
        flushContent();

        // Pop sections until we find the right parent level
        while (sectionStack.length > 1) {
          const parent = sectionStack[sectionStack.length - 1];
          if (parent.heading && parent.heading.level >= heading.depth) {
            sectionStack.pop();
          } else {
            break;
          }
        }

        // Create new section
        const newSection: SectionNode = {
          heading: {
            level: heading.depth,
            text: extractHeadingText(heading),
            position: heading.position!,
          },
          content: '',
          children: [],
          startLine: heading.position!.start.line,
          endLine: heading.position!.end.line,
          containsCode: false,
          containsTable: false,
          containsList: false,
        };

        // Add to parent
        const parent = sectionStack[sectionStack.length - 1];
        parent.children.push(newSection);

        // Push to stack and make current
        sectionStack.push(newSection);
        currentSection = newSection;
      } else {
        // Non-breaking heading - add to content buffer
        contentBuffer.push(node);
      }
    } else if (node.type === 'code') {
      // Code block - always keep intact
      currentSection.containsCode = true;
      if (options.preserveCodeBlocks) {
        flushContent();
        currentSection.content +=
          (currentSection.content ? '\n\n' : '') + extractText(node, markdown);
      } else {
        contentBuffer.push(node);
      }
    } else if (node.type === 'table') {
      // Table - keep intact if preserveTables is true
      currentSection.containsTable = true;
      if (options.preserveTables) {
        flushContent();
        currentSection.content +=
          (currentSection.content ? '\n\n' : '') + extractText(node, markdown);
      } else {
        contentBuffer.push(node);
      }
    } else if (node.type === 'list') {
      // List - keep together if preserveLists is true
      currentSection.containsList = true;
      if (options.preserveLists) {
        flushContent();
        currentSection.content +=
          (currentSection.content ? '\n\n' : '') + extractText(node, markdown);
      } else {
        contentBuffer.push(node);
      }
    } else if (node.type === 'paragraph' || node.type === 'blockquote' || node.type === 'html') {
      // Regular content - add to buffer
      contentBuffer.push(node as RootContent);
    }
  });

  // Flush remaining content
  flushContent();

  return root;
}

// ─── Recursive Token-Based Splitter ──────────────────────────────────────────────

/**
 * Standard recursive separator hierarchy.
 * Tries the highest-level separator first (paragraph breaks).
 * If splits are still too big, recurse with the next separator level.
 */
const RECURSIVE_SEPARATORS = ['\n\n', '\n', '. ', '! ', '? ', '; ', ', ', ' ', ''];

/**
 * Recursively split text that exceeds MAX_CHUNK_TOKENS.
 * Produces chunks of ~TARGET_SPLIT_TOKENS with OVERLAP_TOKENS of overlap.
 */
function recursiveTokenSplit(text: string): string[] {
  const targetChars = TARGET_SPLIT_TOKENS * CHARS_PER_TOKEN;
  const overlapChars = OVERLAP_TOKENS * CHARS_PER_TOKEN;

  return doRecursiveSplit(text, RECURSIVE_SEPARATORS, targetChars, overlapChars);
}

/**
 * Core recursive split logic.
 */
function doRecursiveSplit(
  text: string,
  separators: string[],
  chunkSize: number,
  chunkOverlap: number,
): string[] {
  if (!text.trim()) return [];

  // Base case: text fits within target
  const tokens = countTokens(text);
  if (tokens <= TARGET_SPLIT_TOKENS) {
    return [text.trim()];
  }

  // Find the best separator that exists in the text
  let separator = '';
  let remainingSeparators = separators;
  for (let i = 0; i < separators.length; i++) {
    const sep = separators[i];
    if (sep === '' || text.includes(sep)) {
      separator = sep;
      remainingSeparators = separators.slice(i + 1);
      break;
    }
  }

  // Split text by the chosen separator
  const splits = separator ? text.split(separator) : [...text];

  const chunks: string[] = [];
  let currentChunk = '';

  for (const split of splits) {
    const piece = separator ? split + separator : split;
    const candidateLength = currentChunk.length + piece.length;

    if (candidateLength > chunkSize && currentChunk.length > 0) {
      // Current chunk is big enough — check if it needs further splitting
      const chunkTokens = countTokens(currentChunk);

      if (chunkTokens > TARGET_SPLIT_TOKENS && remainingSeparators.length > 0) {
        // Still too big — recurse with finer separator
        const subChunks = doRecursiveSplit(
          currentChunk,
          remainingSeparators,
          chunkSize,
          chunkOverlap,
        );
        chunks.push(...subChunks);
      } else {
        chunks.push(currentChunk.trim());
      }

      // Apply overlap: keep trailing characters from previous chunk
      if (chunkOverlap > 0 && currentChunk.length > chunkOverlap) {
        currentChunk = currentChunk.slice(-chunkOverlap) + piece;
      } else {
        currentChunk = piece;
      }
    } else {
      currentChunk += piece;
    }
  }

  // Handle remaining text
  if (currentChunk.trim()) {
    const chunkTokens = countTokens(currentChunk);
    if (chunkTokens > TARGET_SPLIT_TOKENS && remainingSeparators.length > 0) {
      const subChunks = doRecursiveSplit(
        currentChunk,
        remainingSeparators,
        chunkSize,
        chunkOverlap,
      );
      chunks.push(...subChunks);
    } else {
      chunks.push(currentChunk.trim());
    }
  }

  return chunks.filter((c) => c.length > 0);
}

// ─── Flatten Sections Into Chunks ────────────────────────────────────────────────

/**
 * Flatten section hierarchy into chunks.
 *
 * Strategy:
 * - Section ≤ maxChunkTokens → single chunk (keep together)
 * - Section > maxChunkTokens → recursive token split into ~1500 token chunks
 *
 * No arbitrary character-based splitting. Only token overflow triggers a split.
 */
function flattenSections(
  section: SectionNode,
  options: Required<MarkdownChunkOptions>,
  parentPath: string[] = [],
): MarkdownChunk[] {
  const chunks: MarkdownChunk[] = [];

  // Build section path
  const sectionPath = section.heading ? [...parentPath, section.heading.text] : parentPath;

  // Build full chunk text: heading + content (never lose the heading)
  const headingPrefix = section.heading
    ? '#'.repeat(section.heading.level) + ' ' + section.heading.text + '\n\n'
    : '';

  // If section has content, create chunk(s)
  if (section.content.trim()) {
    const content = section.content.trim();
    const fullText = headingPrefix + content;
    const fullTokens = countTokens(fullText);

    if (fullTokens > options.maxChunkTokens) {
      // ═══════════════════════════════════════════════════════════════════════
      // FORCE SPLIT — section exceeds token limit (>5000 tokens)
      // Recursive split into ~1500 token chunks with overlap
      // First chunk gets the heading prefix; subsequent chunks don't repeat it
      // ═══════════════════════════════════════════════════════════════════════
      const subChunks = recursiveTokenSplit(content);
      for (let i = 0; i < subChunks.length; i++) {
        const chunkText = i === 0 ? headingPrefix + subChunks[i] : subChunks[i];
        chunks.push({
          text: chunkText,
          metadata: {
            sectionPath,
            containsCode: section.containsCode,
            containsTable: section.containsTable,
            containsList: section.containsList,
            startLine: section.startLine,
            endLine: section.endLine,
            chunkIndex: chunks.length,
          },
        });
      }
    } else {
      // ═══════════════════════════════════════════════════════════════════════
      // KEEP AS-IS — section fits within token limit
      // Header-to-header content stays together as one chunk (heading included)
      // ═══════════════════════════════════════════════════════════════════════
      chunks.push({
        text: fullText,
        metadata: {
          sectionPath,
          containsCode: section.containsCode,
          containsTable: section.containsTable,
          containsList: section.containsList,
          startLine: section.startLine,
          endLine: section.endLine,
          chunkIndex: chunks.length,
        },
      });
    }
  } else if (headingPrefix && section.children.length === 0) {
    // Section has a heading but no body content AND no children.
    // This is a leaf heading with no body (rare edge case) — include it so
    // it merges with the adjacent chunk in the merge pass.
    chunks.push({
      text: headingPrefix.trim(),
      metadata: {
        sectionPath,
        containsCode: false,
        containsTable: false,
        containsList: false,
        startLine: section.startLine,
        endLine: section.endLine,
        chunkIndex: chunks.length,
      },
    });
  }
  // If heading has no body BUT has children, skip creating a chunk for the
  // heading alone. Instead, prepend the parent heading to the first child's
  // chunk text so no information is lost (the heading appears in content,
  // not just metadata). This avoids tiny 6-token heading-only chunks.

  // Recursively process children
  const childChunks: MarkdownChunk[] = [];
  for (const child of section.children) {
    childChunks.push(...flattenSections(child, options, sectionPath));
  }

  // If this section had a heading with no body content but has children,
  // prepend the heading to the first child chunk's text
  if (headingPrefix && !section.content.trim() && childChunks.length > 0) {
    childChunks[0] = {
      ...childChunks[0],
      text: headingPrefix + childChunks[0].text,
    };
  }

  chunks.push(...childChunks);

  return chunks;
}

// ─── Merge Small Chunks ──────────────────────────────────────────────────────────

/**
 * Merge adjacent small chunks to produce substantial, readable chunks.
 *
 * Rules:
 * - If current chunk < mergeTargetTokens AND next chunk < mergeTargetTokens → merge
 * - Keep merging until combined would exceed mergeTargetTokens
 * - Never merge chunks with different section paths (each heading section stays distinct)
 *   Exception: only merge sections that share the SAME immediate parent path
 *   (e.g., two H3 sections under the same H2 can merge, but H2-A and H2-B cannot)
 * - Preserve metadata from the first chunk in the merge group (section path, flags)
 */
function mergeSmallChunks(chunks: MarkdownChunk[], mergeTargetTokens: number): MarkdownChunk[] {
  if (chunks.length <= 1) return chunks;

  const merged: MarkdownChunk[] = [];
  let currentText = chunks[0].text;
  let currentMetadata = { ...chunks[0].metadata };
  let currentTokens = countTokens(currentText);

  for (let i = 1; i < chunks.length; i++) {
    const next = chunks[i];
    const nextTokens = countTokens(next.text);

    // Determine if merging is allowed based on section hierarchy:
    // Two chunks can merge if they share the same parent section path
    // AND their parent path has at least one element (not root-level H1s).
    //
    // This means:
    // - Two H3 sections under the same H2 → CAN merge (parent = ["Doc", "H2"])
    // - Two H2 sections under the same H1 → CAN merge (parent = ["H1"])
    // - Two H1 sections (top-level) → CANNOT merge (each H1 is a major topic)
    // - Root content + first section → CAN merge (pre-heading intro text)
    const currentParentPath = currentMetadata.sectionPath.slice(0, -1);
    const nextParentPath = next.metadata.sectionPath.slice(0, -1);

    const currentIsTopLevel = currentMetadata.sectionPath.length <= 1;
    const nextIsTopLevel = next.metadata.sectionPath.length <= 1;

    // Root content (empty path) can merge with adjacent root content
    const bothRootContent =
      currentMetadata.sectionPath.length === 0 && next.metadata.sectionPath.length === 0;

    // Same parent = sibling sections that can merge
    const sameSiblings =
      currentParentPath.length > 0 && currentParentPath.join(' > ') === nextParentPath.join(' > ');

    // Never merge two top-level (H1) sections — they are distinct major topics
    const bothTopLevel = currentIsTopLevel && nextIsTopLevel;

    const canMerge = (sameSiblings || bothRootContent) && !bothTopLevel;

    // Merge condition: both are small AND mergeable by hierarchy
    if (
      canMerge &&
      currentTokens < mergeTargetTokens &&
      nextTokens < mergeTargetTokens &&
      currentTokens + nextTokens <= mergeTargetTokens
    ) {
      // Merge: combine text
      currentText += '\n\n' + next.text;
      currentTokens = currentTokens + nextTokens; // Approximate (avoids re-tokenizing)
      // Extend end line
      currentMetadata.endLine = next.metadata.endLine;
      // Merge content flags
      currentMetadata.containsCode = currentMetadata.containsCode || next.metadata.containsCode;
      currentMetadata.containsTable = currentMetadata.containsTable || next.metadata.containsTable;
      currentMetadata.containsList = currentMetadata.containsList || next.metadata.containsList;
    } else {
      // Can't merge — flush current and start new
      merged.push({
        text: currentText,
        metadata: { ...currentMetadata, chunkIndex: merged.length },
      });
      currentText = next.text;
      currentMetadata = { ...next.metadata };
      currentTokens = nextTokens;
    }
  }

  // Flush last chunk
  merged.push({
    text: currentText,
    metadata: { ...currentMetadata, chunkIndex: merged.length },
  });

  return merged;
}

// ─── Final Aggressive Merge Pass ────────────────────────────────────────────────

/**
 * Final pass: merge ANY adjacent small chunks regardless of hierarchy.
 *
 * After the sibling merge pass (which respects hierarchy), this pass is
 * hierarchy-agnostic. It merges adjacent chunks when:
 *   - Both are individually < mergeTargetTokens
 *   - Combined ≤ mergeTargetTokens
 *
 * This catches cases that the sibling merge can't handle:
 *   - H1 parent + H2 child (parent-child, not siblings)
 *   - Two H1s that are small enough to merge
 *   - Non-top-level orphans from complex documents
 *   - Footer sections under different headings
 *
 * The rationale: if two adjacent chunks are both under 1500 tokens and
 * combined still fit, there is ZERO retrieval benefit in keeping them
 * separate. One 376-token chunk is better than two 172/204-token chunks.
 */
function mergeAggressively(chunks: MarkdownChunk[], mergeTargetTokens: number): MarkdownChunk[] {
  if (chunks.length <= 1) return chunks;

  const merged: MarkdownChunk[] = [];
  let currentText = chunks[0].text;
  let currentMetadata = { ...chunks[0].metadata };
  let currentTokens = countTokens(currentText);

  for (let i = 1; i < chunks.length; i++) {
    const next = chunks[i];
    const nextTokens = countTokens(next.text);

    // Merge if both are small and combined fits — NO hierarchy check
    const canMerge =
      currentTokens < mergeTargetTokens &&
      nextTokens < mergeTargetTokens &&
      currentTokens + nextTokens <= mergeTargetTokens;

    if (canMerge) {
      // Merge: combine text
      currentText += '\n\n' + next.text;
      currentTokens = currentTokens + nextTokens;
      // Extend end line
      currentMetadata.endLine = next.metadata.endLine;
      // Merge content flags
      currentMetadata.containsCode = currentMetadata.containsCode || next.metadata.containsCode;
      currentMetadata.containsTable = currentMetadata.containsTable || next.metadata.containsTable;
      currentMetadata.containsList = currentMetadata.containsList || next.metadata.containsList;
    } else {
      // Can't merge — flush current and start new
      merged.push({
        text: currentText,
        metadata: { ...currentMetadata, chunkIndex: merged.length },
      });
      currentText = next.text;
      currentMetadata = { ...next.metadata };
      currentTokens = nextTokens;
    }
  }

  // Flush last chunk
  merged.push({
    text: currentText,
    metadata: { ...currentMetadata, chunkIndex: merged.length },
  });

  return merged;
}

// ─── Absorb Micro-Chunks ────────────────────────────────────────────────────────

/**
 * Safety net: absorb any chunk below MIN_CHUNK_TOKENS into its nearest neighbor.
 *
 * After all merge passes, some chunks may still be tiny (e.g., heading-only
 * orphans from pages with complex hierarchy, or footer sections like
 * "### Let's be friends" with just 25 tokens). These micro-chunks:
 *   - Add noise to vector search (embedding of 6 tokens is nearly meaningless)
 *   - Waste embedding computation and storage
 *   - Never produce useful retrieval results
 *
 * Strategy:
 *   - Scan all chunks; if any is < MIN_CHUNK_TOKENS, merge it with the
 *     PREVIOUS chunk (append). If it's the first chunk, merge with next.
 *   - This is hierarchy-agnostic — micro-chunks merge regardless of sectionPath.
 *   - Only merges if combined stays within MAX_CHUNK_TOKENS (safety).
 */
function absorbMicroChunks(chunks: MarkdownChunk[]): MarkdownChunk[] {
  if (chunks.length <= 1) return chunks;

  const result: MarkdownChunk[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const tokens = countTokens(chunk.text);

    if (tokens < MIN_CHUNK_TOKENS) {
      // This chunk is too small — absorb into neighbor
      if (result.length > 0) {
        // Merge into previous chunk (append)
        const prev = result[result.length - 1];
        const combinedTokens = countTokens(prev.text) + tokens;
        if (combinedTokens <= MAX_CHUNK_TOKENS) {
          result[result.length - 1] = {
            ...prev,
            text: prev.text + '\n\n' + chunk.text,
            metadata: {
              ...prev.metadata,
              endLine: chunk.metadata.endLine,
              containsCode: prev.metadata.containsCode || chunk.metadata.containsCode,
              containsTable: prev.metadata.containsTable || chunk.metadata.containsTable,
              containsList: prev.metadata.containsList || chunk.metadata.containsList,
            },
          };
          continue;
        }
      } else if (i + 1 < chunks.length) {
        // First chunk is micro — merge into next chunk (prepend)
        const next = chunks[i + 1];
        const combinedTokens = tokens + countTokens(next.text);
        if (combinedTokens <= MAX_CHUNK_TOKENS) {
          chunks[i + 1] = {
            ...next,
            text: chunk.text + '\n\n' + next.text,
            metadata: {
              ...next.metadata,
              startLine: chunk.metadata.startLine,
              containsCode: chunk.metadata.containsCode || next.metadata.containsCode,
              containsTable: chunk.metadata.containsTable || next.metadata.containsTable,
              containsList: chunk.metadata.containsList || next.metadata.containsList,
            },
          };
          continue;
        }
      }
    }

    // Normal-sized chunk or couldn't absorb — keep as-is
    result.push(chunk);
  }

  return result;
}

// ─── Public API ──────────────────────────────────────────────────────────────────

/**
 * Chunk markdown document with structure awareness
 *
 * Strategy:
 *   1. Parse markdown → AST
 *   2. Split on heading boundaries (H1, H2, H3) → sections
 *   3. Each section ≤ 5000 tokens → single chunk (header-to-header)
 *   4. Each section > 5000 tokens → recursive split into ~1500 token chunks
 *   5. Sibling merge: merge adjacent small chunks under same parent until ~1500 tokens
 *   6. Final H1 merge: merge adjacent small top-level (H1) sections if combined ≤ 1500 tokens
 *
 * @param markdown - Markdown document content
 * @param options - Chunking options
 * @returns Array of markdown chunks with metadata
 */
export function chunkMarkdown(
  markdown: string,
  options: MarkdownChunkOptions = {},
): MarkdownChunk[] {
  // Default options — token-based, no character limits
  const opts: Required<MarkdownChunkOptions> = {
    headingLevels: options.headingLevels ?? [1, 2, 3],
    preserveCodeBlocks: options.preserveCodeBlocks ?? true,
    preserveTables: options.preserveTables ?? true,
    preserveLists: options.preserveLists ?? true,
    maxChunkTokens: options.maxChunkTokens ?? MAX_CHUNK_TOKENS,
    mergeTargetTokens: options.mergeTargetTokens ?? MERGE_TARGET_TOKENS,
  };

  // Parse markdown to AST
  const ast = parseMarkdown(markdown);

  // Build section hierarchy
  const root = buildSectionHierarchy(ast, markdown, opts);

  // Flatten sections into chunks (split only if > maxChunkTokens)
  const rawChunks = flattenSections(root, opts);

  // Merge adjacent small chunks to avoid micro-chunks (siblings under same parent)
  const mergedChunks = mergeSmallChunks(rawChunks, opts.mergeTargetTokens);

  // Final pass: merge ANY adjacent small chunks if combined ≤ mergeTargetTokens (hierarchy-agnostic)
  const finalChunks = mergeAggressively(mergedChunks, opts.mergeTargetTokens);

  // Safety net: absorb any remaining micro-chunks (< MIN_CHUNK_TOKENS) into neighbors.
  // This catches orphan heading-only chunks, tiny footer sections, image placeholders, etc.
  // that couldn't merge in earlier passes due to hierarchy constraints.
  const cleanedChunks = absorbMicroChunks(finalChunks);

  // Re-index chunks
  return cleanedChunks.map((chunk, index) => ({
    ...chunk,
    metadata: {
      ...chunk.metadata,
      chunkIndex: index,
    },
  }));
}

/**
 * Extract heading hierarchy from markdown (without chunking)
 *
 * @param markdown - Markdown document content
 * @returns Array of headings with hierarchy
 */
export function extractHeadings(markdown: string): HeadingNode[] {
  const ast = parseMarkdown(markdown);
  const headings: HeadingNode[] = [];

  visit(ast, 'heading', (node: Heading) => {
    if (node.position) {
      headings.push({
        level: node.depth,
        text: extractHeadingText(node),
        position: node.position,
      });
    }
  });

  return headings;
}
